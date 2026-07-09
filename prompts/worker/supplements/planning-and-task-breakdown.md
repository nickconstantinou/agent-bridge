# Planning and task breakdown

Use this supplement when a worker prompt asks for a plan before code is written.

- Stay in read-only planning mode. Do not edit files.
- Ground the plan in the repository structure, tests, scripts, interfaces, and ownership boundaries.
- Break work into small dependency-ordered tasks.
- Each task must include acceptance criteria, verification commands, likely files touched, dependencies, and estimated size.
- Prefer thin vertical slices over broad horizontal rewrites.
- Mark any task that touches more than five files as too large unless the plan justifies it.
- Surface assumptions and open questions only when missing information changes implementation safety.
- Identify risky areas early: auth, secrets, data deletion, billing, migrations, destructive operations, external API behavior, and irreversible changes.
- End with binary acceptance criteria and copy-pasteable verification commands.

Output should be concrete enough for an autonomous worker to execute without guessing.