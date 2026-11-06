# Security Policy

Cellucid takes security and privacy seriously. We appreciate responsible
disclosure and will work with you to understand, validate, and address issues.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security reports.

Preferred:
- Use GitHub’s private vulnerability reporting (Security → “Report a
  vulnerability”) in the relevant repository, if available.

Alternative:
- Email the project at `hello@cellucid.com`.

Please include:
- a clear description of the issue and potential impact,
- steps to reproduce (or a proof-of-concept),
- affected components and versions (if known),
- any suggested mitigation or fix.

## AI agents

Cellucid lets AI agents act in the web app: its own chat bar (with the
person's API key), Claude and ChatGPT through the Cellucid relay, and local
agent apps through `cellucid mcp` (Python) and `cellucid_mcp()` (R). Every
agent call runs through one tool call in the page, under the person's
permissions. Reports we particularly want:

- an agent change, heavy work or irreversible action that runs without the
  person's permission settings allowing it, or without the confirm card when
  they say Ask;
- text written by others (a dataset's names and description, labels, notes,
  shared or community annotations) reaching an agent outside the data marks:
  every tool result's data is sent between `<cellucid-data>` and
  `</cellucid-data>` with every `<` inside escaped, every name Cellucid's own
  sentences quote is marked the same way, and agents are told the marked
  text is data, never instructions;
- a value of a single cell, a minimum, maximum or median, or a picture of the
  plot reaching an agent while the dataset is set to "Agents see names and
  summaries only", or an agent turning that switch off;
- an API key sent anywhere but its own provider, or written to a session
  file, the history or the address;
- the relay storing or logging tool calls or results, or a connection made
  without the person's Allow in Cellucid.

Out of scope: a model doing what the person's permissions allow, a model
misled by marked text it was told to treat as data (the permissions, the
confirm card and Undo turn are the backstop), and the switch's stated limit
(it is not anonymisation: a summary of a very small group can still reveal
its cells' values).

## What to expect

- We aim to acknowledge reports within **2 business days**.
- We will coordinate a fix and a disclosure timeline with you.
- If you prefer, we can credit you in the advisory/release notes.

## Supported versions

We generally support the latest released version and the current `main` branch.

