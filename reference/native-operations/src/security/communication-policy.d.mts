export function normalizedCommunication(value:unknown):string;
export function executionAccount(value:unknown):boolean;
export function outgoingActionRisk(value:unknown,context?:{reply?:boolean;recipient?:string;participants?:string[]}):string|null;
export function assertConversationOnly(value:unknown,context?:{reply?:boolean;recipient?:string;participants?:string[]}):void;
