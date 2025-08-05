import { z } from 'zod'

export const WorkflowType = z.enum(['scheduling', 'other'])
export type WorkflowType = z.infer<typeof WorkflowType>
