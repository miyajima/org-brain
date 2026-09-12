export function signMemoryUseAttestation(proof:Record<string,unknown>,secret:string):Promise<string>;
export function verifyMemoryUseAttestation(token:string,options:{secret?:string;tenant?:string;principal?:string;now?:number}):Promise<Record<string,any>|null>;
