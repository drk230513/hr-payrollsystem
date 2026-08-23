# Running hr-payrollsystem.com from your own GB10s

Two GB10 nodes, 128GB unified memory each, 5TB storage, linked over QSFP, on
`81.108.239.141`. That is serious hardware — far more than payroll needs and
close to ideal for the AI layer. This works well for the site and the demo.
Read **What to host where** at the end before a customer's payroll goes on it.

## Before anything else

```bash
./preflight.sh
```

It checks the things that actually bite on this setup: ARM64 image
availability, whether the address is really static, whether inbound 80 is
reachable, NTP sync, and the QSFP link to the second node.

---

## Setup, about twenty minutes

### 1. Point the domain at Cloudflare
1. Register **hr-payrollsystem.com** at any registrar.
2. Add the domain to Cloudflare (free plan is enough).
3. Change the nameservers at your registrar to the two Cloudflare gives you.
4. Wait for the domain to show as **Active** — usually under an hour.

### 2. Create the tunnel
1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** → *Create
   a tunnel* → **Cloudflared**.
2. Name it `hrp-prod`. Copy the **token** it shows you.
3. Under **Public hostnames**, add two routes:

   | Subdomain | Domain | Service |
   |---|---|---|
   | *(leave blank)* | hr-payrollsystem.com | `http://web:8080` |
   | `www` | hr-payrollsystem.com | `http://web:8080` |

   The service name is `web` because that is the container name inside the
   docker network — not `localhost`, which would point cloudflared at itself.

### 3. Start it
```bash
cd site/deploy
cp .env.selfhost.example .env
# paste the tunnel token into .env
docker compose -f docker-compose.selfhost.yml up -d
docker compose -f docker-compose.selfhost.yml logs -f tunnel
```

Look for `Registered tunnel connection` in the logs, then load
https://hr-payrollsystem.com. Certificates are handled by Cloudflare; there is
nothing to renew.

### 4. Cloudflare settings worth changing
- **SSL/TLS mode: Full.** The default *Flexible* is fine here because the tunnel
  is already encrypted, but Full is the habit you want.
- **Always Use HTTPS: on.**
- **Caching → Browser Cache TTL:** leave at Respect Existing Headers; nginx
  already sets them.
- Add a **rate limiting rule** on `/` if you start getting scraped.

---

## Making a GB10 behave like a server

The software is the easy part. These are what actually bite.

**Stop it sleeping.** A sleeping machine is an offline website.
- Linux: `sudo systemctl mask sleep.target suspend.target hibernate.target`
- Windows: Settings → Power → Screen and sleep → *Never* (plugged in). Also
  disable *Fast startup*, which interferes with Docker auto-start.
- macOS: `sudo pmset -a sleep 0 disablesleep 1`

**Start on boot.** `restart: always` handles the containers, but Docker itself
must start first. On Linux `sudo systemctl enable docker`. On Windows and macOS,
enable *Start Docker Desktop when you log in* — and note the machine must
actually reach a logged-in desktop session, so disable any login password prompt
that blocks startup, or run Linux where it does not apply.

**Check your upload speed.** Visitors are limited by your *upload*, not
download. The site is around 200 KB and the demo about 180 KB, so even 5 Mbps
upload is comfortable. Cloudflare caches static files at the edge, so most
visitors never touch your connection at all.

**Read your ISP's terms.** Most UK residential contracts prohibit "running
servers". In practice a low-traffic site behind Cloudflare is invisible to them
— there are no inbound connections to notice. But it is their contract, and a
business broadband line removes the question entirely for a few pounds more.

**Power.** A £60 UPS gives you a clean shutdown rather than a corrupted
Postgres data directory. Worth it the first time there is a cut.

**Get backups off the machine.** The `backups/` folder must sync to somewhere
else — another drive at minimum, ideally cloud storage with separate
credentials. Ransomware that reaches your GB10 reaches anything mounted
on it.

---

## Security, given this is also the machine you work on

The uncomfortable part: if this is your daily driver, then everything you browse
shares a host with your server.

- **Nothing is exposed inbound.** No ports are forwarded, so the ordinary attack
  surface is zero. That is the main benefit of the tunnel.
- **Postgres binds to `127.0.0.1` only.** Do not change this to `0.0.0.0`, and
  do not add a tunnel route to it. A payroll database reachable from the
  internet will be found within hours.
- **The tunnel token is a credential.** Anyone with it can publish content at
  your hostname. Keep `.env` out of git — add it to `.gitignore` before your
  first commit, not after.
- **Enable the firewall anyway.** `sudo ufw enable` on Linux; Windows Defender
  Firewall on. Defence in depth costs nothing here.
- **Full disk encryption.** LUKS, BitLocker or FileVault. A stolen laptop with
  an unencrypted payroll database is a reportable data breach.
- **Separate the concerns eventually.** An old ThinkPad running Linux, doing
  nothing but this, is better than your main machine and costs very little.

---

## Where the line is

Run the **marketing site and the demo** from your GB10. That is a normal
thing to do, costs nothing, and no one will ever ask where a brochure is hosted.

Do **not** run live customer payroll from it. The reasons are commercial and
legal before they are technical:

**Procurement will ask.** Every council tender and most private due diligence
asks where data is hosted and who has physical access. "A GB10 in my
office" ends the conversation. It is not a judgement about your security; it is
a box they cannot tick.

**Cyber Essentials Plus** involves an assessor testing the environment. A
dual-purpose GB10 that also browses the web and runs your email is very
hard to pass.

**Professional indemnity insurers** ask about hosting. An honest answer may
affect cover or premium, and a dishonest one voids the policy exactly when you
need it.

**One machine is one failure.** A dead SSD on a Tuesday means a company cannot
pay its staff on Friday. There is no failover, no on-call datacentre, no
redundant power. Payroll has an immovable deadline, which is what makes it
different from most software.

**The DPA you sign** commits you to appropriate technical measures for the data.
A GB10 is defensible for your own test data. It is difficult to defend
for four thousand people's salaries and bank details.

### The sensible progression

1. **Now** — site and demo on the GB10, `.co.uk` registered too. Costs
   about £15 a year.
2. **First paying customer** — move to a small UK VPS. Around £20 a month buys
   a proper answer to the hosting question, and the same compose file runs there
   unchanged.
3. **Public sector or 1,000+ employees** — managed Postgres with automated
   failover, a separate staging environment, Cyber Essentials Plus.

Nothing in what has been built assumes a particular host. The compose file, the
schema and the provisioning script move to a VPS without changes. Starting on
your GB10 costs you nothing later.


---

## ARM64: the practical gotcha

The GB10 is Grace ARM, not x86. Docker will happily pull an amd64 image and
then either refuse to start it or run it under emulation at a fraction of the
speed — and you will not notice until something is slow for no visible reason.

Every service in `docker-compose.selfhost.yml` is pinned to `linux/arm64` so
this fails loudly instead of quietly. `preflight.sh` checks each image for an
arm64 build before you deploy.

The one that commonly has no arm64 build is **pgbouncer**. It is commented out
in the compose file for that reason. You do not need it until you have real
tenants, so this is not urgent — but check before you rely on it.

---

## Using the second GB10

The QSFP link between them is fast and private. Two sensible uses, in order of
value:

**1. A streaming replica.** The primary is configured with `wal_level=replica`
and Postgres binds only to the QSFP address, so the second node can reach it
and nothing on your wider network can. On node two:

```bash
pg_basebackup -h 10.10.10.1 -U replicator -D /var/lib/postgresql/data -R -P
```

This gives you a warm standby and, more importantly, a machine to **restore
backups onto weekly to prove they work**. An untested restore is not a backup,
and this is the cheapest way to test one.

**2. The AI layer.** 128GB of unified memory is wasted on payroll arithmetic
and well suited to running a local model. That matters commercially: a payslip
explainer and a policy assistant that run entirely on your own hardware mean
**employee pay data never leaves the premises**. For a council weighing an AI
feature against a DPIA, "the model runs on our infrastructure and nothing is
sent to a third party" is a far easier answer than naming an American API
provider.

Run inference on node two so a heavy model load can never starve the database.

---

## Do not publish 81.108.239.141

The Cloudflare Tunnel exists so that address is never in DNS. Three reasons
this matters more than usual here:

- A payroll system on a residential or small-business line is an attractive,
  easily-scanned target.
- If the ISP lease renews and the address changes, the tunnel reconnects and
  DNS never moves. With an A record, your customers' payslips vanish.
- Many UK consumer lines block inbound port 80 outright, which breaks
  Let's Encrypt HTTP validation. The tunnel sidesteps it entirely.

Confirm two things with your ISP **in writing**: that the address is static,
and that their terms permit running a commercial service. Consumer contracts
usually prohibit it, and finding out after you have customers is expensive.

---

## What to host where

This is the judgement that matters, and I would not host all of it on these
boxes.

| What | Where | Why |
|---|---|---|
| Marketing site | GB10 | No personal data. Nothing to lose if it goes down for an hour. |
| Interactive demo | GB10 | Synthetic data only. |
| Development and staging | GB10 | Ideal. Fast hardware, no compliance surface. |
| AI inference | GB10 | The genuine differentiator — data never leaves your premises. |
| **Live customer payroll** | **UK cloud region** | See below. |

**Why not live payroll on your own hardware, at least at first:**

- **Procurement will ask.** Cyber Essentials Plus, and any council's security
  questionnaire, asks where data is physically processed and what the physical
  access controls are. "A server in my premises" is a hard answer to defend
  against "AWS London" or "Azure UK South".
- **Your DPIA has to describe physical security.** Locked room, access log,
  fire suppression, visitor control. A cloud region comes with that
  documented; your building probably does not.
- **Professional indemnity and cyber insurance** may exclude or reprice it.
  Ask your broker before, not after.
- **No SLA on a broadband line.** If the connection drops on the 26th, a
  customer cannot pay their staff. That is not a technical inconvenience.
- **Backups on the same premises are not backups.** Fire, theft and ransomware
  all reach both nodes.

None of this makes self-hosting wrong. It makes it wrong *first*. Put the site
and the AI on your hardware now, and move live payroll to a UK region — AWS
`eu-west-2`, Azure UK South, or a UK provider — when you take a paying
customer. The tenant schema already refuses any region that is not `uk-*`, and
`tenant_databases.host` exists precisely so tenants can live on different
hosts. Moving one customer later is a `pg_dump` and a registry row update, not
a rewrite.

A reasonable middle path once you are established: keep live payroll in a UK
cloud region, and keep the AI inference on the GB10s. Then "your pay data is
processed in a UK data centre, and our AI runs on hardware we own" is a
genuinely strong story — and both halves are true.

---

## Your other domains

- **`vinmur.uk`** and **`opensource-ai-cloud.uk`** can point at the same tunnel
  with additional public hostnames; one tunnel serves many domains.
- Keep `hr-payrollsystem.com` as the product's only public name. Do not serve
  it from `opensource-ai-cloud.uk` as well — a payroll buyer who finds the same
  service on two unrelated domains reads it as unfinished.
- `opensource-ai-cloud.uk` is a good home for the AI inference endpoint if you
  ever offer it separately.
