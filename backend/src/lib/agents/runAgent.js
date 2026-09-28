// Shared agent loop used by every Journi agent. Gemini decides which tools to
// call, in what order, and when it has enough to answer; this wrapper adds:
//   - the step limit (stopWhen: stepCountIs(N)),
//   - logging of every tool call to agent_tool_logs (awaited, never silent),
//   - a wrap-up turn when the step limit is hit mid-research,
//   - zod validation of the final JSON with one self-correcting retry
//     (same pattern as services/gemini.js generateJson),
//   - the full tool-call trace, returned for debugging / transparency.

import { randomUUID } from 'node:crypto';
import { generateText, stepCountIs } from 'ai';
import { HttpError } from '../http.js';
import { parseLooseJson } from '../../services/gemini.js';
import { agentModel, agentProviderOptions } from './model.js';
import { logToolCall } from './toolLog.js';

const CALL_TIMEOUT_MS = 150_000;

/** Wraps each tool's execute so every call is traced and logged before its result reaches the model. */
function instrumentTools(tools, run) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, def]) => [
      name,
      {
        ...def,
        execute: async (input, options) => {
          const started = Date.now();
          let result;
          let isError = false;
          try {
            result = await def.execute(input, options);
          } catch (err) {
            // Errors go back to the model as data so it can adapt (retry, pick another tool, ask the user).
            isError = true;
            result = { error: err?.message || String(err) };
            if (!(err instanceof HttpError) || err.status >= 500) console.warn(`[agent:${run.agentName}] ${name} failed:`, err?.message);
          }
          const entry = { step: run.step, tool: name, args: input, result, is_error: isError, duration_ms: Date.now() - started };
          run.trace.push(entry);
          await logToolCall({
            runId: run.runId,
            agentName: run.agentName,
            tripId: run.tripId,
            userId: run.userId,
            toolName: name,
            args: input,
            result,
            isError,
            durationMs: entry.duration_ms,
            step: run.step,
          });
          return result;
        },
      },
    ]),
  );
}

function formatIssues(error) {
  return error.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

function parseOutput(text, schema) {
  if (!text) return { ok: false, message: 'the response was empty' };
  let json;
  try {
    json = parseLooseJson(text);
  } catch (err) {
    return { ok: false, message: err.message };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: formatIssues(parsed.error) };
}

/**
 * Runs one agent loop.
 *
 * @param {object}   opts
 * @param {string}   opts.agentName     e.g. "planner" — logged with every tool call
 * @param {string}   opts.systemPrompt
 * @param {object}   opts.tools         AI SDK tool definitions ({ description, inputSchema, execute })
 * @param {Array}    opts.messages      AI SDK model messages
 * @param {string?}  opts.tripId        trip the run is about (for logs), or null
 * @param {string?}  opts.userId        user the run acts for (for logs), or null
 * @param {number}   opts.stepLimit     max model steps (tool rounds + final answer)
 * @param {import('zod').ZodType?} opts.outputSchema  validates the final JSON; omit for plain text
 * @param {string?}  opts.wrapUpPrompt  sent if the step limit is hit before a final answer
 * @param {number?}  opts.temperature
 * @param {object?}  opts.model         override the language model (tests)
 * @returns {Promise<{ output: any, text: string, toolCalls: Array, steps: number, stepLimitReached: boolean, retried: boolean, runId: string, usage: object }>}
 */
export async function runAgent({
  agentName,
  systemPrompt,
  tools = {},
  messages,
  tripId = null,
  userId = null,
  stepLimit,
  outputSchema = null,
  wrapUpPrompt = null,
  temperature = 0.4,
  model = agentModel,
}) {
  const run = { runId: randomUUID(), agentName, tripId, userId, step: 0, trace: [] };
  const instrumented = instrumentTools(tools, run);
  const providerOptions = agentProviderOptions();
  const usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
  const addUsage = (u) => {
    usage.inputTokens += u?.inputTokens ?? 0;
    usage.outputTokens += u?.outputTokens ?? 0;
  };

  const call = (extra) =>
    generateText({
      model,
      system: systemPrompt,
      tools: instrumented,
      maxRetries: 0, // the fallback chain in model.js handles retries
      temperature,
      providerOptions,
      abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      onStepFinish: (step) => {
        usage.modelCalls++;
        addUsage(step.usage);
        run.step++;
      },
      ...extra,
    });

  const started = Date.now();
  const result = await call({ messages, stopWhen: stepCountIs(stepLimit) });
  let conversation = [...messages, ...result.response.messages];
  let text = result.text?.trim() || '';

  // The loop stopped on the step limit while the model still wanted tools:
  // ask for its best answer now (no more tools) instead of guessing.
  const lastStep = result.steps.at(-1);
  const stepLimitReached = result.steps.length >= stepLimit && (lastStep?.finishReason === 'tool-calls' || !text);
  if (stepLimitReached) {
    console.warn(`[agent:${agentName}] step limit (${stepLimit}) reached — asking for a wrap-up answer`);
    const wrapUp = await call({
      messages: [
        ...conversation,
        {
          role: 'user',
          content:
            wrapUpPrompt ||
            'You have used all your tool steps. Do not call any more tools. Give your best final answer now from what you already know, in the required format.',
        },
      ],
      toolChoice: 'none',
    });
    conversation = [...conversation, ...wrapUp.response.messages];
    text = wrapUp.text?.trim() || '';
  }

  let output = text;
  let retried = false;
  if (outputSchema) {
    let parsed = parseOutput(text, outputSchema);
    if (!parsed.ok) {
      // One self-correcting retry, feeding the validation error back to the model.
      retried = true;
      console.warn(`[agent:${agentName}] invalid final output: ${parsed.message} — retrying once`);
      const fix = await call({
        messages: [
          ...conversation,
          ...(text ? [] : [{ role: 'assistant', content: '(no answer)' }]),
          {
            role: 'user',
            content: `Your previous response could not be used: ${parsed.message}. Respond again with ONLY the complete, corrected JSON object that follows the required format exactly. No markdown, no commentary, no tool calls.`,
          },
        ],
        toolChoice: 'none',
        temperature: 0.2,
      });
      text = fix.text?.trim() || '';
      parsed = parseOutput(text, outputSchema);
      if (!parsed.ok) {
        throw new HttpError(502, 'The AI planner returned an unexpected response. Please try again.', parsed.message);
      }
    }
    output = parsed.data;
  }

  console.log(
    `[agent:${agentName}] ${run.trace.length} tool call(s) in ${usage.modelCalls} model call(s), ${Date.now() - started}ms` +
      (stepLimitReached ? ' (step limit hit)' : '') +
      (retried ? ' (output retried)' : ''),
  );

  return {
    output,
    text,
    toolCalls: run.trace,
    steps: result.steps.length,
    stepLimitReached,
    retried,
    runId: run.runId,
    usage: { ...usage, durationMs: Date.now() - started },
  };
}

/** Compact, UI-friendly view of a run: which tools the agent used, in order. */
export function summarizeTrace(agentName, run) {
  return {
    agent: agentName,
    run_id: run.runId,
    steps: run.steps,
    step_limit_reached: run.stepLimitReached,
    tool_calls: run.toolCalls.map((c) => ({ step: c.step, tool: c.tool, args: c.args, ok: !c.is_error, duration_ms: c.duration_ms })),
    model_calls: run.usage.modelCalls,
    duration_ms: run.usage.durationMs,
  };
}
