import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

const HIE_RESOURCE_NAMESPACE = "39b3d252-b530-5cbd-8911-4a67f5d27877";

const inputSchema = z.object({
  environment: z.enum(["TEST", "PRODUCTION"]),
  clinicId: z.number().int().positive(),
  localResourceType: z.string().trim().min(1),
  localResourceId: z.string().trim().min(1),
  hieResourceType: z.string().trim().min(1),
});

export function deterministicHieResourceId(
  input: z.infer<typeof inputSchema>
): string {
  const value = inputSchema.parse(input);
  return uuidv5(
    [
      value.environment,
      String(value.clinicId),
      value.localResourceType,
      value.localResourceId,
      value.hieResourceType,
    ].join(":"),
    HIE_RESOURCE_NAMESPACE
  );
}

export function hieOutboxIdempotencyKey(
  input: z.infer<typeof inputSchema> & { operation: string }
): string {
  return [
    input.environment,
    String(input.clinicId),
    input.localResourceType,
    input.localResourceId,
    input.hieResourceType,
    input.operation,
  ].join(":");
}
