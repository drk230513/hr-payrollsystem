# Cloudflare Tunnel setup

Why a tunnel rather than port forwarding:

- **Your home IP is never published.** `81.108.239.141` stays private. Right now
  it is in DNS for anyone to scan; a payroll target on a residential line is a
  gift to an attacker.
- **Nothing inbound is opened.** The tunnel dials out. No port forwarding, no
  firewall holes, and an ISP blocking inbound 80 stops being your problem.
- **A dynamic address stops mattering.** If your lease renews and the address
  changes, the tunnel reconnects and DNS never moves.
- **DDoS absorption and TLS at the edge**, free.

## Steps

1. Add `hr-payrollsystem.com` to Cloudflare and point the registrar at
   Cloudflare's nameservers.
2. Zero Trust → Networks → Tunnels → Create a tunnel. Copy the token.
3. Put it in `.env` as `CLOUDFLARE_TUNNEL_TOKEN=`.
4. Add public hostnames on the tunnel:

   | Hostname | Service |
   |---|---|
   | `hr-payrollsystem.com` | `http://web:8080` |
   | `www.hr-payrollsystem.com` | `http://web:8080` |

5. Cloudflare creates the DNS records itself. Do not add A records to
   `81.108.239.141`.
6. SSL/TLS mode: **Full**. Enable Always Use HTTPS and Automatic HTTPS Rewrites.
7. Turn on HSTS in Cloudflare once you are confident, starting with a short
   max-age.

## Keep the admin side off the public internet

Do not expose the database, or any future admin interface, through a public
hostname. Put them behind a Cloudflare Access application requiring your
identity provider, or reach them over the tunnel with `cloudflared access`.
The public tunnel should serve the marketing site and the demo, nothing else.
