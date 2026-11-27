# Libre Closet (vibed)

Self-hosted wardrobe organizer: catalog clothes, build outfits, plan them on a
calendar, track wear and laundry, and try outfits on with local AI.

Open the web UI on port 3000.

## Options

| Option | Default | |
| --- | --- | --- |
| `auth_enabled` | `false` | Require login. Items added while login was off are hidden once it's on: move them with Backup → Download export / Import zip after registering. |
| `disable_registration` | `false` | Block new sign-ups (turn on after creating your account). |
| `currency` | `EUR` | Currency for garment prices. |
| `weather_enabled` | `true` | `false` = no external weather calls. |
| `app_name` | `Libre Closet` | Name shown in the app. |

## AI try-on

Try-on → Try-on settings → **Download try-on model** downloads the runtime
and models (~6-7 GB) into the add-on's data folder. They are excluded from
Home Assistant backups and can be re-downloaded any time.

## Updates

Every change to the `main` branch of
https://github.com/coffeec0der/vibed-closet is built by GitHub and published
as a new version. Turn on **Auto update** on this add-on's page to install
updates automatically.
