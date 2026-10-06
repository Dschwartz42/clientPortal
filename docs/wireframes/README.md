# Design notes

## User stories

1. As an org admin, I want to see at a glance whether revenue is up or down this month,
   so I know whether anything needs my attention today.
2. As a team member, I want to find a client account by name and see its recent
   transactions, so I can answer a client's billing question while they are on the phone.
3. As an org admin, I want to invite a colleague and control what they can change,
   so the team can look things up without being able to edit or close accounts.

## Wireframes

Sketches: `dashboard.jpg`, `accounts.jpg`, `account-detail.jpg`, `users.jpg` (this folder).

```
Dashboard
+-----------+--------------------------------------------------------+
| Client    | Acme Corp                         Jane Doe  ADMIN  [⎋] |
| Portal    +--------------------------------------------------------+
|           | [Active accts] [Monthly value] [30d revenue ▲9.5%] [Gold] |
| Dashboard | +----------------------------------------------------+ |
| Accounts  | | Net revenue, last 12 months (line)                 | |
| Users*    | +----------------------------------------------------+ |
| Audit*    | +----------------------+ +---------------------------+ |
|           | | New accounts (bars)  | | Top 5 accounts (table)    | |
| *admin    | +----------------------+ +---------------------------+ |
+-----------+--------------------------------------------------------+

Accounts
| [Search........] [Status v] [Tier v]                 [New account*] |
| Name ^      | Status  | Tier   | Monthly value | Opened            |
| ...rows (click a row to open it)...                                |
| Showing 1–25 of 220                                  [Prev] [Next] |

Account detail
| ← Accounts                                                         |
| Initech Supplies   (active)                      [Edit*] [Close*]  |
| Tier: gold   Monthly value: $2,400.00   Owner: Jane Doe            |
| Opened: Mar 1, 2025   Revenue (30d): $3,150.00                     |
| Transactions: Date | Type | Amount | Description      [Prev][Next] |

Users (admin)
| Users                                               [Invite user]  |
| Name | Email | Role [admin v] | Status [Deactivate] | Last login   |
```

## Decision that came out of this

The revenue trend and its percentage change sit above the fold on the dashboard,
ahead of the tables, because "are we up or down?" is the first question an admin asks
(story 1). Account search is a single box rather than an advanced filter form because
story 2 happens mid-phone-call: one field, results as you type.
