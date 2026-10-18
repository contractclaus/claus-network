"""Loss-aware visible-context conversion; provider reasoning blobs remain archived."""
def text_content(content):
    if isinstance(content,str): return content
    if content is None: return ''
    if not isinstance(content,list): raise ValueError('unsupported_content')
    parts=[]
    for part in content:
        if part.get('type') not in ('text','input_text','output_text'): raise ValueError('unsupported_multimodal_context')
        parts.append(part['text'])
    return '\n'.join(parts)

def translate(request,model):
    messages=[]
    opaque=0
    if request.get('instructions'): messages.append({'role':'system','content':request['instructions']})
    for item in request['input']:
        kind=item.get('type','message')
        if kind=='reasoning':
            opaque+=1
            summary=item.get('summary',[])
            if summary:
                messages.append({'role':'assistant','content':'Prior reasoning summary: '+text_content([{'type':'text','text':p['text']} for p in summary])})
        elif kind=='function_call':
            messages.append({'role':'assistant','content':None,'tool_calls':[{'id':item['call_id'],'type':'function','function':{'name':item['name'],'arguments':item['arguments']}}]})
        elif kind=='function_call_output':
            messages.append({'role':'tool','tool_call_id':item['call_id'],'content':text_content(item['output'])})
        elif kind=='message':
            if item.get('role') not in ('system','developer','user','assistant'): raise ValueError('unsupported_role')
            messages.append({'role':'system' if item['role']=='developer' else item['role'],'content':text_content(item.get('content',''))})
        else: raise ValueError('unsupported_response_item')
    output={'model':model,'messages':messages,'stream':False,'max_tokens':request['max_output_tokens']}
    if not isinstance(output['max_tokens'],int) or not 1<=output['max_tokens']<=131072: raise ValueError('output_size')
    if request.get('tools'):
        if any(t.get('type')!='function' for t in request['tools']): raise ValueError('unsupported_tool')
        output['tools']=[{'type':'function','function':{k:v for k,v in t.items() if k not in ('type','strict')}} for t in request['tools']]
        output['tool_choice']=request.get('tool_choice','auto')
        output['parallel_tool_calls']=False
    return output,{'visibleContextPreserved':True,'opaqueReasoningItemsArchived':opaque,'providerReasoningTransferable':opaque==0,'truncated':False}
