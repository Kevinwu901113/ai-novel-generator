# Third-Party Notices

## PlotPilot（墨枢）

This project contains an integration adapter intended to interoperate with PlotPilot.
PlotPilot itself is not copied, vendored, or distributed within this repository.

- Upstream project: `shenminglinyi/PlotPilot`
- Upstream license: Apache License 2.0 with Commons Clause License Condition v1.0
- Upstream copyright and attribution notices must be retained when PlotPilot is vendored, redistributed, or packaged with this project.

### Usage terms

- Users must provide their own PlotPilot checkout; this project does not clone, download, or install PlotPilot.
- The current use is personal learning, research, and entertainment.
- If PlotPilot source code or binaries are later placed inside this repository or an application package, include the complete upstream `LICENSE` and any applicable `NOTICE` files alongside the redistributed material, and clearly mark local modifications.
- The Commons Clause condition prohibits selling PlotPilot itself. Commercial redistribution of PlotPilot alongside this application requires a separate license agreement with the upstream author.
- This project does not imply or grant any right to unconditionally redistribute PlotPilot commercially.

### Data boundaries

- The two SQLite databases (app.sqlite and project.sqlite) do not share write access with PlotPilot.
- The local manuscript revision is the source of truth for user-confirmed text.
- PlotPilot only manages its own runtime state, retrieval indexes, and generation checkpoints.
