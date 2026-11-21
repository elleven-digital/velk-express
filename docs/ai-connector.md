# AI connector

The AI connector lets your team use the panel by talking to an AI app: "what needs me today?", "reply to ticket #42 saying it ships tomorrow", "log 30 minutes on #42", "draft a website quote for Acme Bakery". It works with Claude (web, desktop and Claude Code), with ChatGPT, and with any other app that supports remote MCP connectors.

Each install is its own connector: the app signs people in with the same panel account they already use, and there is nothing to configure and nothing to run besides the panel. No environment variable is needed.

The AI app always acts as the person who connected it, with that person's role and permissions. A collaborator who connects it sees only what the panel shows a collaborator. The tools call the same code as the panel, so the same rules apply: a role that cannot do something in the panel cannot do it through the connector either.

## Requirements

- The public address of your install must be `https://`. AI apps refuse a connector on plain `http://`, except on `localhost`. See [reverse proxy](reverse-proxy.md) and [configuration](configuration.md).
- The person needs a team account (owner, manager or collaborator). Client portal accounts cannot connect.

## The connector address

The address is your public address plus `/mcp`, for example `https://panel.example.com/mcp`. **Settings → AI connections** shows it, ready to copy.

## Connect an app

In every app, you paste the address, the app opens a "Authorize access" page of your panel, you sign in if needed, and you approve. That is all.

### Claude (web and desktop)

1. Open **Settings → Connectors**.
2. Choose **Add custom connector**.
3. Paste the connector address and confirm.
4. Sign in to your panel account when asked and approve the access.

### Claude Code

```sh
claude mcp add --transport http velk-express https://panel.example.com/mcp
```

Then run `/mcp` inside Claude Code, pick `velk-express` and authenticate. A browser window opens on your panel.

### ChatGPT

ChatGPT supports custom MCP connectors on some plans, usually behind a developer mode setting. Where it is offered, create a new connector, paste the connector address, choose OAuth as the authentication, and approve the access on your panel. ChatGPT's menus and plan availability change often, so look for the option to add a custom MCP connector in its settings.

### Other apps

Any app that supports remote MCP servers over HTTP with OAuth 2.1 works. Give it the connector address; it discovers the rest by itself.

## See and revoke connections

Everyone sees their own connections in **Settings → AI connections**: the app's name, since when it is connected and when it was last used. **Revoke** cuts the app off at its next request.

Connections also end by themselves when:

- the person changes or resets their password;
- the person is removed from the team;
- the app is not used for 60 days.

## Changing the public address

The connector is tied to the public address of the install. If you change the address (the `APP_URL` variable, or the address in **Settings → Installation**), existing connections stop working and each person has to connect again. Nothing is deleted: remove the old connector in the AI app and add it again with the new address.

## What the connector can do

The connector has 59 tools. The **Who** column is the role that can call the tool:

- **Everyone**: owner, manager and collaborator (a collaborator only sees what the panel shows them).
- **Owner and manager**: not available to collaborators.
- **Owner**: only the owner.

Money: amounts in answers are in cents, with their currency. Amounts sent as `*_cents` fields (for example `value_cents`) are in cents too. The plan amounts and the hour package price are typed as text, the way you type them in the panel, for example `1.200,50`.

### General

| Tool | Who | What it does |
|---|---|---|
| `get_agency` | Everyone | The connected person and role, the agency (name, language, currency, time zone, panel address) and what collaborators may see. |
| `get_home` | Everyone | What needs the person: unassigned open tickets, their tickets the client answered, and this month's figures. |

### Tickets

| Tool | Who | What it does |
|---|---|---|
| `list_tickets` | Everyone | Lists tickets with filters (status, client, mine, unassigned, unread, label, search). |
| `get_ticket` | Everyone | One ticket with the whole conversation, labels, responsibles and time entries. Does not mark it as read. |
| `open_ticket` | Everyone | Opens a ticket for a client. |
| `reply_to_ticket` | Everyone | Writes a message on a ticket. |
| `edit_ticket_message` | Everyone | Edits a message (your own; owners and managers can edit more, as in the panel). |
| `delete_ticket_message` | Everyone | Deletes a message, with the same rules as editing. |
| `assume_ticket` | Everyone | The person takes the ticket as responsible. |
| `assign_ticket` | Owner and manager | Adds a team member as responsible. |
| `unassign_ticket` | Owner and manager | Removes a responsible. |
| `close_ticket` | Everyone | Closes a ticket. |
| `reopen_ticket` | Everyone | Reopens a closed ticket. |
| `log_time` | Everyone | Logs whole minutes worked on a ticket. |
| `delete_time_entry` | Everyone | Deletes a time entry (its author, owners and managers). |
| `set_ticket_value` | Owner and manager | Sets the agreed value of a one-off ticket, in cents. |

### Labels

| Tool | Who | What it does |
|---|---|---|
| `list_labels` | Everyone | Lists the ticket labels. |
| `create_label` | Owner and manager | Creates a label. |
| `update_label` | Owner and manager | Renames or recolors a label. |
| `delete_label` | Owner and manager | Deletes a label. |
| `add_ticket_label` | Everyone | Puts a label on a ticket. |
| `remove_ticket_label` | Everyone | Takes a label off a ticket. |

### Clients

| Tool | Who | What it does |
|---|---|---|
| `list_clients` | Everyone | Lists the clients the person can see. |
| `get_client` | Everyone | One client with sites, support plan, hours mode and open tickets. Collaborators do not see amounts or team. |
| `create_client` | Owner and manager | Registers a client. |
| `update_client` | Owner and manager | Changes a client's data and support plan (only the fields given). |
| `set_client_team` | Owner and manager | Sets which team members take part in a client. |
| `set_client_rotation` | Owner and manager | Sets the client's own rotation of client-opened tickets. |
| `add_site` | Owner and manager | Adds a site to a client. |
| `update_site` | Owner and manager | Changes a site (only the fields given). |
| `delete_site` | Owner and manager | Deletes a site. |
| `get_hours` | Owner and manager | A client's hours for a monthly cycle. |
| `add_hour_package` | Owner and manager | Records extra hours bought for a cycle. |
| `delete_hour_package` | Owner and manager | Deletes an hour package that has no live charge. |
| `get_portal_access` | Owner and manager | Who can enter the client's portal, with role and status. |
| `invite_to_portal` | Owner and manager | Invites a person to the client's portal. |
| `resend_portal_invite` | Owner and manager | Sends a new invite to someone who has not accepted. |
| `cancel_portal_invite` | Owner and manager | Cancels an invite nobody accepted. |
| `set_portal_role` | Owner and manager | Sets a portal login's role (admin or collaborator). |
| `remove_from_portal` | Owner and manager | Takes a person out of the client's portal. |

### Quotes

| Tool | Who | What it does |
|---|---|---|
| `list_quotes` | Owner | Lists quotes, filtered by status or client. |
| `get_quote` | Owner | One quote with items and totals. |
| `create_quote` | Owner | Creates a draft quote for a client or a prospect. |
| `update_quote` | Owner | Replaces a draft or sent quote's data and items. |
| `send_quote` | Owner | Marks the quote as sent and e-mails the link. |
| `archive_quote` | Owner | Archives a quote that was not executed. |

### Charges

| Tool | Who | What it does |
|---|---|---|
| `list_charges` | Owner and manager | Lists charges. |
| `get_charge` | Owner and manager | One charge with status, amount and payment page. |
| `create_charge` | Owner and manager | Creates a charge and returns its payment page. Charging from a quote is owner only. |
| `cancel_charge` | Owner and manager | Cancels a charge. |
| `mark_charge_paid` | Owner and manager | Records that a one-time charge was paid outside the payment page. |

### Team

| Tool | Who | What it does |
|---|---|---|
| `list_team` | Owner and manager | Lists the team. Owners also get e-mails, pending invites and each member's clients; managers get names and roles. |
| `invite_member` | Owner | Invites someone to the team by e-mail. |
| `change_member_role` | Owner | Changes a member's role. |
| `remove_member` | Owner | Removes a member from the team. |
| `set_member_clients` | Owner | Sets which clients a member takes part in. |

### Settings

| Tool | Who | What it does |
|---|---|---|
| `update_agency` | Owner | Changes the agency's name, currency, language and time zone. |
| `set_collaborator_visibility` | Owner | Sets what collaborators can see. |
| `set_auto_assign` | Owner | Turns the agency's ticket rotation on or off and sets who takes part. |

## Safety

- The AI app only sees what the connected person can see, and every write goes through the panel's own rules.
- Ticket messages, titles, notes and names written by people (clients included) are treated as data, never as instructions. Inviting people, changing roles, removing people and charging clients happen only when the connected person asks.
- Invite and password links, keys and codes never appear in a tool's answer or in the log. When no e-mail is set up, the answer says so and the link stays in the panel for you to copy.
- Each connection is limited to 60 requests per minute.
- Every write is logged with the person, the tool and the app, never with its content.

## What is left out

- The client portal: clients use the portal itself, not the connector.
- Closing and executing a quote, and deleting one.
- Sending files: ticket attachments, the logo and fiscal documents.
- Password and personal profile.
- Changing the public address. Doing it through the connector would cut the connection itself, so change it in **Settings → Installation** or with `APP_URL`.
