import {createHash} from 'node:crypto';
export function validateProgram(program) {
 if(!program||![1,2].includes(program.version)||Object.keys(program).some(k=>!['version','lines'].includes(k))||!Array.isArray(program.lines)||!program.lines.length||program.lines.length>(program.version===2?2048:240)||program.lines.some(line=>typeof line!=='string')||Buffer.byteLength(JSON.stringify(program))>(program.version===2?128000:24000))throw Error('isolated_program_invalid');
 return program.lines.join('\n');
}
export const programHash=program=>createHash('sha256').update(validateProgram(program)).digest('hex');

