# AllTrails Provider Research

Last checked: 2026-05-11

## Summary

AllTrails should be treated as an import-only provider unless AllTrails grants explicit partner/API access.

The clean supported path is manual file export from AllTrails followed by Dofek import. AllTrails documents exports for activities, custom routes, and trail pages in formats including GPX Track, FIT, TCX, GeoJSON Track, JSON Track, CSV, KML, and KMZ.

Automatic account sync is not currently a good fit for production because the available web endpoints are private, undocumented, blocked by anti-bot protection, and covered by terms/robots restrictions against automated scraping.

## Officially Documented Surfaces

### File Export

AllTrails documents downloading activity files from the website:

- Log in.
- Open the profile activity list.
- Open an activity.
- Use the overflow menu.
- Choose "Download route".
- Pick an export format.

AllTrails also documents exports for custom routes and trail pages. Relevant formats for Dofek are:

- GPX Track
- Garmin FIT
- Garmin Course TCX
- GeoJSON Track
- JSON Track
- CSV

Source: https://support.alltrails.com/hc/en-gb/articles/37230403315476-Downloading-files-from-AllTrails

### Route Converter

AllTrails has a route converter that converts uploaded route/activity files into supported output formats.

Source: https://support.alltrails.com/hc/en-us/articles/360038438192-How-do-I-convert-my-files

### AI Assistant Integration

AllTrails documents integrations with ChatGPT and Claude for trail discovery. The documented capabilities are trail search, trail details, trailhead weather, and map display. The support page says no API keys, accounts, or user-side configuration are required.

This appears to be a consumer assistant integration, not a public developer API suitable for backend provider sync.

Source: https://support.alltrails.com/hc/en-us/articles/47343827423764-AllTrails-integrations-with-AI-assistants

### Garmin Integration

AllTrails can send routes to Garmin Connect for Plus or Peak users. This proves AllTrails has partner integrations, but it does not expose an integration contract that Dofek can use.

Source: https://support.alltrails.com/hc/en-us/articles/37215864354836-How-to-send-AllTrails-routes-to-Garmin-Connect

## Private Web API Findings

The AllTrails web app uses private JSON endpoints. One member profile page exposed a personal feed request with this shape:

```text
https://www.alltrails.com/api/alltrails/community/blazes/v0/users/<alltrails_user_id>/feeds/personal?requestedFeedItemVersions%5Blist%3Aitem%3Aadded%5D=1&requestedFeedItemVersions%5Bactivity%3Aphotos%3Auploaded%5D=1&requestedFeedItemVersions%5Btrail%3Aphotos%3Auploaded%5D=1
```

Direct backend access returned:

```text
HTTP/2 403
x-datadome: protected
Please enable JS and disable any ad blocker
```

This means the endpoint is behind DataDome bot protection when called outside a normal browser session.

An open-source tool, `alltrailsgpx`, also documents a private route endpoint pattern:

```text
https://www.alltrails.com/api/alltrails/v3/trails/{route_id}
```

That tool requires manually saving a browser network response, then converting it to GPX. It does not provide a documented authentication or sync path for user activities.

Source: https://github.com/cdown/alltrailsgpx

## Scraping And Policy Constraints

AllTrails' terms prohibit automated agents/scripts that generate requests or queries to scrape, strip, or mine data from the product.

Source: https://www.alltrails.com/terms

AllTrails' `robots.txt` disallows:

```text
/api/
/api-v4/
/api-v5/
/*/api/
/*/api-v4/
/*/api-v5/
/members/
/explore/map/
```

Source: https://www.alltrails.com/robots.txt

Because the feed endpoint is under `/api/` and was discovered from `/members/`, it is not a suitable target for a production provider.

## Integration Recommendation

Implement AllTrails as an import-only provider.

Start with GPX Track import because it is documented, common, and enough for basic activity path/time/elevation import. Add FIT or TCX later if AllTrails exports preserve richer metrics that GPX does not.

Do not implement scheduled sync against private AllTrails web endpoints unless all of the following are true:

- AllTrails grants explicit API/partner permission.
- The endpoint contract is documented or otherwise stable enough to support.
- Auth does not require bypassing bot protection or browser challenges.
- The implementation can pass normal provider validation without hidden cookies from a human browser session.

## Open Questions

- Does AllTrails FIT export include heart rate, calories, cadence, or other sensor streams, or only route geometry?
- Does GPX Track export from an activity include original timestamps for every track point?
- Are activity exports available for all user-recorded activities or only certain subscription/account states?
- Is there a partner API path available through AllTrails support or business development?
