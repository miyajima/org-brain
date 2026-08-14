import Ajv from "ajv";
import envelopeSchema from "../schemas/envelope.schema.json";
import taskCreateSchema from "../schemas/task_create.schema.json";
import taskResultSchema from "../schemas/task_result.schema.json";
import memoryContractV2Schema from "../schemas/memory_contract_v2.schema.json";

const ajv = new Ajv({ allErrors: true, strict: false });

export const validateEnvelope = ajv.compile(envelopeSchema);
export const validateTaskCreateBody = ajv.compile(taskCreateSchema);
export const validateTaskResultPayload = ajv.compile(taskResultSchema);
export const validateMemoryContractV2Event = ajv.compile(memoryContractV2Schema);
