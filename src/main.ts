import { readFileSync } from "node:fs";
import { z } from "zod";
import { startAnalysisWorker } from "./analysis.js";
import { service } from "./api.js";
import { rulesSchema } from "./domain.js";
import { GitHub } from "./github.js";
import { modelAdvisor } from "./review.js";
import { Store } from "./store.js";

const env = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3040),
  DATABASE_PATH: z.string().default("data/reviews.db"),
  REPOSITORIES_FILE: z.string().default("repositories.example.json"),
  WEBHOOK_SECRET: z.string().min(32),
  OPERATOR_TOKEN: z.string().min(32),
  GITHUB_TOKEN: z.string().min(1),
  AUTO_ANALYZE: z.enum(["true", "false"]).default("true"),
  MODEL_API_KEY: z.string().min(1).optional(),
  MODEL_NAME: z.string().min(1).optional(),
  MODEL_ENDPOINT: z.url().default("https://api.openai.com/v1/chat/completions")
}).safeParse(process.env);

if (!env.success) {
  console.error("Invalid configuration: " + env.error.issues.map(item => item.path.join(".")).join(", "));
  process.exit(1);
}
const config = env.data;
if (new Set([config.WEBHOOK_SECRET, config.OPERATOR_TOKEN, config.GITHUB_TOKEN]).size !== 3) {
  throw new Error("Configure distinct webhook, operator, and GitHub credentials.");
}
const endpoint = new URL(config.MODEL_ENDPOINT);
if (config.MODEL_API_KEY && (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || !config.MODEL_NAME)) {
  throw new Error("Set MODEL_NAME and an HTTPS model endpoint without credentials in its URL.");
}
const settings = rulesSchema.parse(JSON.parse(readFileSync(config.REPOSITORIES_FILE, "utf8")));
const repos = Object.fromEntries(Object.entries(settings).map(([repo, rules]) => [repo.toLowerCase(), rules]));
const store = new Store(config.DATABASE_PATH);
const setup = {
  webhookSecret: config.WEBHOOK_SECRET,
  operatorToken: config.OPERATOR_TOKEN,
  repos,
  staticDir: "web/dist",
  store,
  github: new GitHub(config.GITHUB_TOKEN),
  advise: config.MODEL_API_KEY && config.MODEL_NAME ? modelAdvisor({
    key: config.MODEL_API_KEY, model: config.MODEL_NAME, endpoint: endpoint.href
  }) : undefined
};
const app = service(setup);
const stopWorker = config.AUTO_ANALYZE === "true" ? startAnalysisWorker(setup) : undefined;
app.listen(config.PORT, config.HOST, () => console.log(JSON.stringify({ event: "listening", host: config.HOST, port: config.PORT })));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    const drained = stopWorker?.();
    app.close(() => { void Promise.resolve(drained).then(() => store.close()); });
  });
}
