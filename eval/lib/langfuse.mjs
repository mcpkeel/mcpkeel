// Sends an eval run (eval/explain.mjs, eval/agent/honeytoken.mjs) to Langfuse
// as an experiment, for development
// only: nothing here is part of the mcpkeel package, and the CLI sends nothing
// anywhere. Plain fetch, no SDK:
//
//   dataset items   POST /api/public/dataset-items, upserted on stable ids
//   one trace each  POST /api/public/otel/v1/traces (OTLP/HTTP JSON), with the
//                   experiment attributes Langfuse reads to build the run
//   scores          POST /api/public/scores, on each item's root span
//
// Keys come from the environment: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and
// LANGFUSE_BASE_URL, e.g. `node --env-file=$HOME/.config/mcpkeel/langfuse.env`.
// See https://langfuse.com/integrations/native/opentelemetry/experiments.
import { randomBytes } from "node:crypto";

const EXPLAIN = {
  name: "mcpkeel-explain",
  description: "mcpkeel --explain eval: MCPTox poisoned tools, rug pulls, and real drift from the nightly canary. See eval/explain.mjs.",
  scope: "mcpkeel/eval/explain",
};

const hex = (bytes) => randomBytes(bytes).toString("hex");
const nanos = (ms) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

/** OTLP attributes from a flat object; objects become JSON strings. */
function attributes(record) {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (typeof value === "number") return { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } };
      if (typeof value === "boolean") return { key, value: { boolValue: value } };
      return { key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } };
    });
}

/** A client, or an error naming what is missing, before any model is called. */
export async function connect(env = process.env) {
  const missing = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`--langfuse needs ${missing.join(", ")}; run with --env-file=$HOME/.config/mcpkeel/langfuse.env`);
  const base = env.LANGFUSE_BASE_URL.replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64")}`;

  async function call(method, path, body) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json", "x-langfuse-ingestion-version": "4" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Langfuse ${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
    const json = text ? JSON.parse(text) : {};
    // 207: some items rejected. The scores endpoint asks not to retry these.
    if (response.status === 207) throw new Error(`Langfuse ${method} ${path}: partly rejected: ${text.slice(0, 300)}`);
    return json;
  }

  // Checks the keys before any model is called.
  const projects = await call("GET", "/api/public/projects");
  return { call, base, project: projects.data?.[0]?.id };
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) await fn(items[next++]); }));
}

/**
 * Sends one run.
 *   items:   [{ id, set, input, expected, output, scores: {name: value}, generation?,
 *               name?, metadata?, startMs?, endMs?, spans? }]
 *            generation: { model, startMs, endMs, input, output, batch, batchSize }
 *            spans: [{ key, parent?, name, type, startMs, endMs, input?, output?, model?,
 *                      usage?, level?, statusMessage?, metadata? }], children of the
 *                   item's root span, or of the span whose key is `parent`
 *   run:     { name, description, metadata }
 *   dataset: { name, description, scope }, the explain eval's by default
 */
export async function sendExperiment(client, { items, run, dataset: target = EXPLAIN }) {
  const DATASET = target.name;
  // The dataset and its items: upserted, so every run links the same items.
  let dataset;
  try {
    dataset = await client.call("GET", `/api/public/v2/datasets/${encodeURIComponent(DATASET)}`);
  } catch {
    dataset = await client.call("POST", "/api/public/v2/datasets", {
      name: DATASET,
      description: target.description,
    });
  }
  await pool(items, 8, (item) =>
    client.call("POST", "/api/public/dataset-items", {
      datasetName: DATASET,
      id: `${DATASET}:${item.id}`,
      input: item.input,
      expectedOutput: item.expected,
      metadata: { set: item.set },
    }),
  );

  // One trace per item, the item's root span carrying the experiment
  // attributes, and a child generation for the batch request it was part of.
  const experiment = { "langfuse.experiment.id": hex(8), "langfuse.experiment.name": run.name, "langfuse.experiment.dataset.id": dataset.id, "langfuse.environment": "experiment" };
  for (const [key, value] of Object.entries(run.metadata ?? {})) experiment[`langfuse.experiment.metadata.${key}`] = String(value);

  const spans = [];
  const scores = [];
  for (const item of items) {
    const traceId = hex(16);
    const rootId = hex(8);
    const g = item.generation;
    const start = item.startMs ?? g?.startMs ?? run.startMs;
    const end = item.endMs ?? g?.endMs ?? start;
    const name = item.name ?? `explain ${item.set}`;
    const itemAttrs = { "langfuse.experiment.item.id": `${DATASET}:${item.id}`, "langfuse.experiment.item.root_observation_id": rootId };
    spans.push({
      traceId,
      spanId: rootId,
      name,
      kind: 1,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(end),
      attributes: attributes({
        ...experiment,
        ...itemAttrs,
        "langfuse.trace.name": name,
        ...Object.fromEntries(Object.entries(item.metadata ?? {}).map(([key, value]) => [`langfuse.trace.metadata.${key}`, String(value)])),
        "langfuse.experiment.description": run.description,
        "langfuse.experiment.item.expected_output": item.expected,
        "langfuse.experiment.item.metadata.set": item.set,
        "langfuse.observation.input": item.input,
        "langfuse.observation.output": item.output,
      }),
    });
    if (g) {
      // A request reviews a batch of changes; its tokens are split evenly over
      // the batch, so per-item cost is an apportioned estimate.
      spans.push({
        traceId,
        spanId: hex(8),
        parentSpanId: rootId,
        name: "review batch",
        kind: 3,
        startTimeUnixNano: nanos(g.startMs),
        endTimeUnixNano: nanos(g.endMs),
        attributes: attributes({
          ...experiment,
          ...itemAttrs,
          "langfuse.observation.type": "generation",
          "langfuse.observation.model.name": g.model,
          "langfuse.observation.usage_details": { input: Math.round(g.input / g.batchSize), output: Math.round(g.output / g.batchSize) },
          ...(g.cost === undefined ? {} : { "langfuse.observation.cost_details": { total: g.cost / g.batchSize } }),
          "langfuse.observation.metadata.batch": String(g.batch),
          "langfuse.observation.metadata.batch_size": String(g.batchSize),
          "langfuse.observation.metadata.usage": "the batch request's tokens divided by the batch size",
        }),
      });
    }
    const ids = new Map((item.spans ?? []).map((span) => [span.key, hex(8)]));
    for (const span of item.spans ?? []) {
      spans.push({
        traceId,
        spanId: ids.get(span.key),
        parentSpanId: ids.get(span.parent) ?? rootId,
        name: span.name,
        kind: span.type === "generation" ? 3 : 1,
        startTimeUnixNano: nanos(span.startMs),
        endTimeUnixNano: nanos(Math.max(span.endMs, span.startMs)),
        attributes: attributes({
          ...experiment,
          ...itemAttrs,
          "langfuse.observation.type": span.type,
          "langfuse.observation.input": span.input,
          "langfuse.observation.output": span.output,
          "langfuse.observation.model.name": span.model,
          "langfuse.observation.usage_details": span.usage,
          "langfuse.observation.level": span.level,
          "langfuse.observation.status_message": span.statusMessage,
          ...Object.fromEntries(Object.entries(span.metadata ?? {}).map(([key, value]) => [`langfuse.observation.metadata.${key}`, String(value)])),
        }),
      });
    }
    for (const [name, value] of Object.entries(item.scores)) {
      const dataType = typeof value === "boolean" ? "BOOLEAN" : typeof value === "number" ? "NUMERIC" : "CATEGORICAL";
      scores.push({ traceId, observationId: rootId, name, value: typeof value === "boolean" ? Number(value) : value, dataType, environment: "experiment" });
    }
  }

  const resource = { attributes: attributes({ "service.name": "mcpkeel-eval", "langfuse.environment": "experiment" }) };
  for (let i = 0; i < spans.length; i += 500) {
    await client.call("POST", "/api/public/otel/v1/traces", {
      resourceSpans: [{ resource, scopeSpans: [{ scope: { name: target.scope }, spans: spans.slice(i, i + 500) }] }],
    });
  }
  for (let i = 0; i < scores.length; i += 200) await client.call("POST", "/api/public/scores", scores.slice(i, i + 200));
  return { datasetId: dataset.id, traces: items.length, spans: spans.length, scores: scores.length, url: `${client.base}/project/${client.project}/datasets/${dataset.id}` };
}
