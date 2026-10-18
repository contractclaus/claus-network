"""Set independent sequence heads from retained source state and copied rows."""
import psycopg
from psycopg import sql
from psycopg.rows import dict_row

def restore(connection):
    with psycopg.connect(**connection,row_factory=dict_row) as control:
        records=control.execute("SELECT name,body FROM continuity.replication_state WHERE body->>'state'='current'").fetchall()
    if len(records)!=7:raise ValueError('sequence_checkpoints_incomplete')
    changes=[]
    for record in records:
        with psycopg.connect(**{**connection,'dbname':'recovery_'+record['name']},row_factory=dict_row) as target:
            for seq in record['body']['sequences']:
                name=sql.Identifier(seq['schemaname'],seq['sequencename'])
                current=target.execute(sql.SQL('SELECT last_value,is_called FROM {}').format(name)).fetchone()
                owned=target.execute("SELECT n.nspname,c.relname,a.attname FROM pg_depend d JOIN pg_class c ON c.oid=d.refobjid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid=%s::regclass AND d.deptype IN('a','i')",(name.as_string(target),)).fetchone()
                values=[v for v in [seq['last_value'],current['last_value'] if current['is_called'] else None] if v is not None]
                if owned:
                    aggregate='max' if seq['increment_by']>0 else 'min'
                    row=target.execute(sql.SQL('SELECT {}({}) AS value FROM {}').format(sql.SQL(aggregate),sql.Identifier(owned['attname']),sql.Identifier(owned['nspname'],owned['relname']))).fetchone()
                    if row['value'] is not None:values.append(row['value'])
                aggregate='max' if seq['increment_by']>0 else 'min'
                head=target.execute(sql.SQL("SELECT {}((h->>'value')::bigint) value FROM public.claus_continuity_barriers b CROSS JOIN LATERAL jsonb_array_elements(b.sequence_heads) h WHERE h->>'schema'=%s AND h->>'name'=%s").format(sql.SQL(aggregate)),(seq['schemaname'],seq['sequencename'])).fetchone()
                if head['value'] is not None:values.append(head['value'])
                if not values:continue
                value=max(values) if seq['increment_by']>0 else min(values)
                target.execute('SELECT setval(%s::regclass,%s,true)',(name.as_string(target),value))
                changes.append({'database':record['name'],'sequence':name.as_string(target),'value':value})
    return changes
