import { z } from "zod";

export const repoName = z.string().max(141).regex(/^[a-zA-Z0-9-]{1,39}\/[a-zA-Z0-9_.-]{1,100}$/)
  .refine(name => ![".", ".."].includes(name.split("/")[1] ?? ""));
export const head = z.string().regex(/^[0-9a-f]{40}$/);
const paths = z.array(z.string().trim().min(1).max(120)).max(20);

export const rulesSchema = z.record(repoName, z.object({
  maxFiles: z.number().int().min(1).max(40),
  largeChange: z.number().int().min(1).max(10_000),
  criticalPrefixes: paths,
  excludeModelPrefixes: paths
}).strict());

export const webhook = z.object({
  action: z.string(),
  number: z.number().int().positive().max(2_147_483_647),
  repository: z.object({ full_name: repoName }),
  pull_request: z.object({ head: z.object({ sha: head }) })
});

export const fileSchema = z.object({
  filename: z.string().min(1).max(1000),
  status: z.string().max(30),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional()
});

export const checkSchema = z.object({
  name: z.string().max(300),
  status: z.string().max(30),
  conclusion: z.string().max(30).nullable()
});

export const suggested = z.object({
  file: z.string().max(1000),
  severity: z.enum(["low", "medium", "high"]),
  message: z.string().trim().min(1).max(320),
  line: z.number().int().positive().optional(),
  evidence: z.string().trim().min(1).max(250).optional()
}).strict();

export type Rules = z.infer<typeof rulesSchema>[string];
export type File = z.infer<typeof fileSchema>;
export type Check = z.infer<typeof checkSchema>;
export type Suggestion = z.infer<typeof suggested>;

export type Pull = { repo: string; number: number; sha: string };
export type Draft = {
  risk: "low" | "medium" | "high";
  scopes: { files: number; checks: number; bounded: boolean };
  rules: string[];
  files: Omit<File, "patch">[];
  checks: Check[];
  suggestions: Suggestion[];
  model: "disabled" | "used" | "unavailable";
};

export type Review = Pull & {
  id: string;
  status: "queued" | "ready" | "publishing" | "published" | "uncertain";
  draft: Draft | null;
  external_id: number | null;
  created_at: string;
  approved_at: string | null;
  analyzing: boolean;
  analysis_error: string | null;
  history: { event: string; at: string }[];
};

export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly retryAfter?: number) {
    super(code);
  }
}
