/** One Jev call to prove the API key works. */
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { loadDotEnv } from "../src/env.js";
import { USD_PER_INPUT_TOKEN } from "../src/types.js";

loadDotEnv();

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const client = new TypeSafeClient();
const response = await client.systemOne({
  state: "Smoke test: the number seven is greater than the number three.",
  questions: {
    true_statement: noul("Is the statement in the state true?"),
  },
});

console.log(
  JSON.stringify(
    {
      model: response.model,
      probability_true: response.answers.true_statement.noul,
      usage: response.usage,
      est_cost_usd: Number(
        (response.usage.input_tokens * USD_PER_INPUT_TOKEN).toFixed(6),
      ),
    },
    null,
    2,
  ),
);
