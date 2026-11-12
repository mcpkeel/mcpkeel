import Link from "next/link";
import { SITE } from "@/lib/site";

// Measured numbers, each linked to where it was measured: eval/results/ and
// docs/EVIDENCE.md in the repository.
export function Proof() {
  return (
    <section className="proof wrap" aria-label="Measured">
      <ul>
        <li>
          <span className="figure figure-critical">0 / 80</span>
          <span className="label">
            agent sessions leaked a planted secret through a rug-pulled MCP server with the mcpkeel plugin, against 17 of 80
            without it. Eight models, real Claude Code sessions.
          </span>
          <a className="source" href={SITE.agentEval}>
            How it was measured
          </a>
        </li>
        <li>
          <span className="figure">99.8%</span>
          <span className="label">of 485 poisoned tools from the MCPTox benchmark graded critical with a model review, against 10.3% by the built-in checks alone</span>
          <a className="source" href={SITE.measured}>
            Why both matter
          </a>
        </li>
        <li>
          <span className="figure">0</span>
          <span className="label">attacks lowered to low by the reviewer, in every recorded run: eleven models, up to 515 attacks each</span>
          <a className="source" href={SITE.evidence}>
            The runs
          </a>
        </li>
        <li>
          <span className="figure">Nightly</span>
          <span className="label">nine popular public servers, unpinned, compared with the night before</span>
          <Link className="source" href="/drift">
            The drift feed
          </Link>
        </li>
      </ul>
    </section>
  );
}
