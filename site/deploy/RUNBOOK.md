# Runbook — every command, in order

For Ubuntu on the GB10. Copy and paste one block at a time.

**Do you need a Python venv?** No. Everything runs in Docker containers, so
there is no Python environment to create or activate. You would only want a
venv later if you run AI inference on the second node.

Lines starting with `$` are commands — do not type the `$`.

---

## Step 1 · Get the files onto the GB10

Download `hr-payrollsystem.tar.gz` from this chat, then move it across.

**If you are sitting at the GB10**, put it in your home folder and:

```
$ cd ~
$ tar -xzf hr-payrollsystem.tar.gz
$ cd hr-payrollsystem
$ ls
```

Expected: `database  site`

**If the GB10 is another machine on your network**, from your laptop:

```
$ scp hr-payrollsystem.tar.gz youruser@81.108.239.141:~/
$ ssh youruser@81.108.239.141
$ tar -xzf hr-payrollsystem.tar.gz && cd hr-payrollsystem
```

---

## Step 2 · Install Docker

```
$ cd ~/hr-payrollsystem/site/deploy
$ chmod +x *.sh
$ ./setup.sh
```

It will ask for your sudo password. Expect it to finish with a "Done" section.

**If it says you were added to the docker group**, log out and back in now:

```
$ exit
```

then SSH back in (or close and reopen the terminal), and:

```
$ cd ~/hr-payrollsystem/site/deploy
```

Check Docker works without sudo:

```
$ docker run --rm hello-world
```

Expected: *Hello from Docker!*
If you get "permission denied", you have not logged out and back in yet.

---

## Step 3 · Register the domain

Do this in a browser, not the terminal.

1. Buy **hr-payrollsystem.com** at any registrar (Namecheap, Cloudflare
   Registrar, 123-reg — all fine).
2. Also buy **hr-payrollsystem.co.uk**. UK buyers will type it.

---

## Step 4 · Add the domain to Cloudflare

Still in the browser.

1. Create a free account at cloudflare.com.
2. **Add a site** → type `hr-payrollsystem.com` → choose the **Free** plan.
3. Cloudflare shows you two nameservers, something like
   `dana.ns.cloudflare.com` and `rick.ns.cloudflare.com`.
4. Go to your registrar, find **Nameservers**, and replace what is there with
   those two.
5. Back in Cloudflare, wait until the domain shows **Active**. Usually under an
   hour, occasionally longer.

**Do not create any A record pointing at 81.108.239.141.** The tunnel creates
its own DNS records, and keeping your home address out of DNS is the point.

---

## Step 5 · Create the tunnel

In Cloudflare:

1. Left sidebar → **Zero Trust**.
2. **Networks** → **Tunnels** → **Create a tunnel**.
3. Choose **Cloudflared**. Name it `hrp-prod`. Save.
4. It offers install instructions — **ignore them**, Docker handles it. Just
   copy the long **token** shown in the command (the string after
   `--token`, roughly 180 characters).
5. Click **Next**, then add two public hostnames:

   | Subdomain | Domain | Service type | URL |
   |---|---|---|---|
   | *(leave blank)* | hr-payrollsystem.com | HTTP | `web:8080` |
   | `www` | hr-payrollsystem.com | HTTP | `web:8080` |

6. Save the tunnel.

---

## Step 6 · Paste the token

Back in the terminal:

```
$ cd ~/hr-payrollsystem/site/deploy
$ nano .env
```

Find the line `CLOUDFLARE_TUNNEL_TOKEN=` and paste your token after the `=`.
No quotes, no spaces.

Save and exit nano: **Ctrl+O**, **Enter**, **Ctrl+X**.

Check it took:

```
$ grep -c '^CLOUDFLARE_TUNNEL_TOKEN=.\+' .env
```

Expected: `1`. If it prints `0`, the token did not save.

---

## Step 7 · Preflight

```
$ ./preflight.sh
```

Read the FAIL lines. Warnings about a static IP and the second node are
expected at this stage and will not stop you.

If it fails on **NTP**, fix it before continuing:

```
$ sudo timedatectl set-ntp true
```

---

## Step 8 · Start

```
$ ./start.sh
```

Expected, after about thirty seconds:

```
Live at https://hr-payrollsystem.com
Demo at https://hr-payrollsystem.com/demo
```

---

## Step 9 · Check it

```
$ curl -I https://hr-payrollsystem.com
```

Expected: `HTTP/2 200`

Then open it in a browser, and check the demo loads at
`https://hr-payrollsystem.com/demo`.

---

## Step 10 · Turn on HTTPS properly

In Cloudflare, for this domain:

- **SSL/TLS** → Overview → set encryption mode to **Full**
- **SSL/TLS** → Edge Certificates → turn on **Always Use HTTPS**

---

## Everyday commands

```
$ cd ~/hr-payrollsystem/site/deploy

$ docker compose -f docker-compose.selfhost.yml ps         # what is running
$ docker compose -f docker-compose.selfhost.yml logs -f     # follow all logs
$ docker compose -f docker-compose.selfhost.yml logs -f tunnel
$ docker compose -f docker-compose.selfhost.yml restart web
$ docker compose -f docker-compose.selfhost.yml down        # stop everything
$ ./start.sh                                                # start again
```

**After editing the site's HTML**, no restart is needed — nginx serves it from
disk. Just reload the browser with Ctrl+Shift+R.

---

## When something is wrong

**`docker: permission denied`**
You have not logged out since being added to the docker group.
Quick fix for this session: `newgrp docker`

**Tunnel will not connect**

```
$ docker compose -f docker-compose.selfhost.yml logs tunnel | tail -30
```

Usually the token is wrong or truncated. Re-copy it and check
`grep CLOUDFLARE_TUNNEL_TOKEN .env | wc -c` is around 190.

**Site shows Cloudflare error 502**
The tunnel is up but cannot reach nginx. Check the service URL in the
Cloudflare hostname settings is exactly `web:8080` — not `localhost:8080`.

**`exec format error` in the logs**
An amd64 image got pulled on ARM64 hardware.

```
$ docker compose -f docker-compose.selfhost.yml pull
$ docker compose -f docker-compose.selfhost.yml up -d
```

**Domain still not resolving after an hour**

```
$ dig +short hr-payrollsystem.com
```

Empty means Cloudflare has not taken over DNS yet. Check the nameservers at
your registrar actually changed.

---

## What is running after all this

| Container | Doing what |
|---|---|
| `web` | nginx serving the site and the demo, on an internal port only |
| `tunnel` | outbound connection to Cloudflare — the only thing facing the internet |
| `postgres` | database, reachable only over the QSFP link |
| `backup` | dumps every tenant database daily, keeps 30 days |

Nothing listens on a public port. Your address stays out of DNS.

---

## Not yet, but soon

- Confirm with your ISP **in writing** that 81.108.239.141 is static and that
  running a commercial service is permitted.
- Fill in the footer placeholders in `site/index.html`: company number,
  registered office, ICO reference.
- Register with the ICO before the enquiry form collects anything.
- Set up the weekly restore drill on the second GB10 — see `SELFHOST.md`.

Full list in `site/LAUNCH.md`.
