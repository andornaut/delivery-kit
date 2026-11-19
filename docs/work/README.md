# Work items

Each user request is one file, `docs/work/<id>.md`, whether or not it is approved. It records scope and milestones; live
progress (claims, blocks, receipts and acceptance) stays in the work protocol state root. The
[design index](../design/README.md) lists the work items of each area.

| Front matter | Content                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `id`         | `dk-` and a zero-padded sequence (`dk-0001`), allocated in chronological order. |
| `title`      | A short imperative title.                                                       |
| `status`     | `proposed`, `approved`, `declined`, `done`, `cancelled` or `superseded`.        |
| `approved`   | A short approval reference, such as `user, 2026-11-18`.                         |
| `design`     | The design area in `docs/design/`.                                              |
| `related`    | A list of related work IDs.                                                     |
| `supersedes` | The ID of the item this one replaces; omitted otherwise.                        |

The sections are Scope, Criteria, Decisions and Outcome. Decisions and Outcome state what was
decided or delivered, and why, in a line or two each.

- Only `main` edits design index tables and approved scope. Approval commits the work-file stub
  and its index row on `main`, and that commit allocates the ID.
- Workers edit only their own work file and the design prose that ships with their feature.
  The commit that lands the item sets `status: done`; a release tag containing that commit marks
  it deployed.
- A changed or reverted decision is a new work item with `supersedes`. A finished item's outcome
  is never rewritten.
- Work files are public: no session IDs, hostnames, local home-directory paths or quoted
  conversation, only short approval references.
- Docs-only changes run only the attribution and lint checks ([dk-0014](dk-0014.md)).
- Work files are not part of the npm package.
