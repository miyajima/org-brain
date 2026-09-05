export function assertV3ProviderProfile(): never;
export function validateV3Packet(packet: Record<string, unknown>): void;
export function validateV3Candidate(raw: unknown, packet: Record<string, any>): {valid: boolean; reason: string | null};
