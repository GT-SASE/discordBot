# Handoff

Student maintainers graduate. This guide moves the bot to the next person without losing access or data, and without leaving the old maintainer able to reach it.

Start at least a month before the outgoing maintainer leaves. Do it together, on a call for the parts that need both people. Dashboards change, so where this says **check this in the dashboard**, the official docs did not confirm the step.

## The order

1. The incoming maintainer secures their accounts.
2. A fresh manual export is taken, so nothing is lost if a step goes wrong.
3. Move each account.
4. Rotate every secret.
5. Delete old deployments and remove the outgoing maintainer.
6. Test the bot, then write down the date.

## Step 1: Secure the new accounts

The incoming maintainer follows Part 1 of [SETUP.md](SETUP.md) on all four accounts. Use a long-lived personal email for recovery, not a university address.

## Step 2: Take an export first

The outgoing maintainer takes a manual export, as in [RECOVERY.md](RECOVERY.md#a-manual-export), and keeps it until Step 6 is done. Backups themselves come from Supabase, so there is no key or separate repository to hand over.

## Step 3: Move each account

### GitHub

1. Move the main repo under Settings > General > Danger Zone > Transfer ownership. The new owner accepts by email. Check this in the dashboard.
2. The incoming maintainer clones the repo, then runs `npm ci --ignore-scripts`, `npm run gitleaks:install` and `npm run hooks:install`. Confirm `git config user.email` shows their noreply address.
3. They also set up the clone's local excludes, as in "Before you start" in [SETUP.md](SETUP.md). The list belongs to one clone, so the outgoing maintainer passes on theirs privately, and it should not go in this repo. They can print it with `cat "$(git rev-parse --git-path info/exclude)"`.

Keep the repo on a personal account while it is private. Vercel Hobby cannot deploy a private repo owned by a GitHub organisation.

**Failure looks like:** a repo that Vercel can no longer see after the transfer. The Vercel part below replaces that link.

### Supabase

The incoming maintainer needs this before the Vercel part, to create the new key.

1. In the organisation's settings, invite the incoming maintainer as an Owner. Check this in the dashboard, including whether the Free plan allows it.
2. They accept, then confirm they can open both projects and the SQL Editor.
3. Remove the outgoing maintainer last, after Step 5.

If the incoming maintainer wants their own organisation, Supabase allows moving a project between organisations. The person moving it must own the source organisation and be at least a member of the target. Projects cannot change region this way.

### Discord

The incoming maintainer needs this before the Vercel part, to reset the token and change the endpoint URL.

A Discord app cannot be given directly to a person. It must go through a team, and that move is permanent.

1. If the apps are not on a team, the outgoing maintainer creates one on the Teams page, then uses **Transfer App to Team** on each app's General Information page. Creating or joining a team requires two-factor authentication.
2. Invite the incoming maintainer as an admin.
3. Hand over team ownership. A team has one owner. Discord's docs do not describe how to transfer it, so check this in the portal.
4. Confirm that the incoming maintainer can see the Bot page and the Interactions Endpoint URL.

Do not invite the bot again. It stays in the club's server. If the club's roles changed, an Administrator runs `/setup` again.

Check the server side too. Ask who holds Administrator, Manage Roles and the two bound roles, and remove anyone who has left.

### Vercel

**Why Hobby has one owner.** Vercel's docs say Hobby does not support collaboration on private repos. For a private repo, Vercel deploys a commit only if its author is the Hobby team's owner, and it does not deploy a private repo owned by a GitHub organisation. So the bot cannot be shared with a co-owner on Hobby. The new maintainer needs their own Vercel projects, or a paid team.

Vercel's project transfer needs the sender to own the source team and be a member of the target team. Two separate Hobby accounts do not appear able to meet that, so this guide recreates the projects. Check this in the dashboard. A Pro team could hold both people, and would cost money.

The steps, for test first, then production:

1. On the old project, use Settings > Cron Jobs > Disable Cron Jobs. Otherwise both projects will run the daily job.
2. The incoming maintainer creates a new project from the transferred repo, as in Part 5 of [SETUP.md](SETUP.md), including the production branch, Standard Protection and firewall rules.
3. The incoming maintainer generates the first three secrets in the Step 4 table now, and adds them to the new project with the other settings. Do not copy old values. Creating a new Supabase key leaves the old one working until it is revoked. Resetting the bot token cuts off the old project at once, so its posts and reminders fail from then on. Do this together, and go straight on to steps 4 and 5.
4. Push a commit authored by the incoming maintainer, so that Vercel accepts the deployment.
5. Change the Interactions Endpoint URL in Discord to the new domain, and test `/ping`.
6. Delete the old project. This removes its deployments and their stored settings.

A project's name decides its URL. The old name stays taken until the old project is deleted, so expect a new URL.

**Failure looks like:** a deployment blocked for its commit author. The newest commit must be authored by the new owner, and their Vercel account must be linked to their GitHub.

## Step 4: Rotate every secret

Do this even if nobody has done anything wrong. The outgoing maintainer knew every value. The incoming maintainer generates them, and the outgoing one never sees them.

The first three rows were generated for the new Vercel project in Step 3. Finish them here, including revoking the old Supabase key. If a value is set after a deployment, redeploy, because a deployment does not pick up new values.

| Secret                     | Where                                        | Then                                                            |
| -------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`        | Developer Portal > Bot > Reset Token         | Set in Vercel and redeploy. Reset cuts off the old one at once. |
| `SUPABASE_SECRET_KEY`      | Supabase > Settings > API Keys, create new   | Set in Vercel, redeploy, then revoke the old key.               |
| `CRON_SECRET`              | `openssl rand -hex 32 \| tr -d '\n'`         | Set in Vercel and redeploy.                                     |
| Supabase database password | Supabase > database settings                 | Store it in the password manager only.                          |
| Personal tokens            | GitHub, Vercel and Supabase account settings | The outgoing maintainer deletes any made for this bot.          |

Do this for the test and production columns. Use different values in each.

`DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `ALLOWED_GUILD_IDS` and `SUPABASE_URL` are not secret and stay the same.

The outgoing maintainer also deletes any local `.env`, clones holding real data, and manual exports, and removes secrets from their password manager once this is finished.

## Step 5: Clean up

1. If you kept any old Vercel project, delete every deployment made before the rotation, as described in [SECURITY.md](../SECURITY.md). Old deployments may hold old values.
2. Remove the outgoing maintainer from the Supabase organisation, the Discord team and the GitHub repo.
3. Check that no Vercel integration or GitHub app remains from the old account.

## Step 6: Test, and record it

1. Run `/ping`, `/config` and `/mytasks`.
2. Run these against the new domain and confirm 401 for the first and `ok` for the second, after setting `URL` and `CRON` in your terminal:

   ```sh
   curl -i "$URL/api/cron/reminders"
   curl -i -H "Authorization: Bearer $CRON" "$URL/api/cron/reminders"
   ```

3. Confirm that the old values fail: a request using the old `sb_secret_` key gets a 401, and the old cron secret gets a 401 from the new project.
4. Check `job_runs` for a good reminder run the next day, and the Database > Backups page for a recent backup if the plan has them. A run can succeed and still leave something for you to look at: in its `results`, `threads_held` counts events whose post refused the bot, and `held_event_ids` lists up to 25 of them.
5. The incoming maintainer takes their own manual export. The outgoing one then deletes theirs.
6. Write the date somewhere the next maintainer will find it. Keep that note out of this repo if it names people.

## Yearly review

Once a year, ideally when officers change, the current maintainer checks:

**Accounts**

- [ ] All four accounts still have working two-factor methods, and the recovery codes are where you think they are.
- [ ] Recovery emails still work and will keep working after graduation.
- [ ] GitHub SSH keys, tokens and authorised apps are all still needed. Check the same on Vercel and Supabase.
- [ ] Vercel Hobby's non-commercial terms still fit how the club uses the bot.

**Access**

- [ ] The list of people holding Administrator, Manage Roles and the two bound roles is short and current. Discord's audit log keeps entries for 45 days only, and the bot is not told about grants. Do this each term if you can.
- [ ] A second trusted officer who can reach the manual exports is still reachable, and is still the right person.
- [ ] The Discord team and Supabase organisation hold only current people.

**Recovery**

- [ ] The Database > Backups page shows what you expect for the plan. See [RECOVERY.md](RECOVERY.md).
- [ ] A manual export was taken this term, and older ones beyond the last two are deleted.
- [ ] A restore was rehearsed on the test project this year.

**Service**

- [ ] Usage is well below Vercel's and Supabase's limits, and the database has room. `history.row_versions` has no retention, so it only grows.
- [ ] Dependabot pull requests have been reviewed, not left open.
- [ ] Legacy keys, GraphQL and sign-ups are still off, and Exposed schemas still lists only `public`. Platform changes may alter defaults.
- [ ] Firewall rules are still in place. Delete stale deployments you do not need for rollback.
- [ ] Rotate `CRON_SECRET`, the bot token and the Supabase secret key if the year has seen any doubt about them.
- [ ] Read `SECURITY.md` and this guide, and fix anything that has gone out of date.
