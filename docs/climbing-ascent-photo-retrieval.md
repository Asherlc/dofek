# Climbing ascent photo retrieval audit

Read-only research on 2026-10-26. This records retrieval evidence, not shipped
photo import support. No authenticated account credentials were used.

## Results

| Provider | Photo retrieval | Association to one logged ascent |
| --- | --- | --- |
| KAYA | Photo fields observed in the current application fragment; see [the existing field audit](kaya.md#confirmed-request-coverage). | Explicit ascent photo object. The newly extended logbook query still needs authenticated validation. |
| OpenBeta | Production GraphQL returned photo metadata; fetching the returned path through the production media host returned JPEG bytes. | Production schema and editor associate media with users and climb/area tags, not ticks. No ascent association was established. |
| Mountain Project | The public photo dialog exposed a full-photo link that returned JPEG bytes. | The inspected tick feed and photo dialog supplied no linking field. No ascent association was established. |
| theCrag | Documentation establishes photo APIs and oEmbed, but the attempted public photo/oEmbed requests returned HTTP 403. | Personal logbook notes are available. Explicit photo embeds in those notes are a candidate link, not yet an end-to-end verified retrieval path. |

## OpenBeta: verified metadata and byte retrieval

The [published GraphQL schema](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/graphql/schema/Media.gql)
defines paginated user media. A read-only request to the production
[GraphQL endpoint](https://api.openbeta.io) resolved the public example profile
`thickles` through `userPage`, then executed:

```graphql
query PhotoAudit($id: ID!) {
  getUserMediaPagination(input: { userUuid: $id, first: 2 }) {
    mediaConnection {
      edges {
        cursor
        node {
          id
          mediaUrl
          width
          height
          format
          entityTags { targetId type }
        }
      }
      pageInfo { hasNextPage totalItems endCursor }
    }
  }
}
```

Both requests returned HTTP 200. The media response had two entries, four total,
and `hasNextPage: true`; `endCursor` was null. A consumer must use the last
edge's cursor as `after`, rather than requiring `endCursor`.
The first entry reported dimensions 4032 by 3024 and a relative `.jpeg` path.

The current public [profile](https://openbeta.io/u/thickles) JavaScript assets
exposed `https://media.openbeta.io` as the production image host. Resolving the
returned relative path against that origin and performing GET returned HTTP
200, `image/jpeg`, and 4,530,000 bytes. No resizing query parameters were added.
This verifies retrievable bytes; it does not independently prove camera-original
resolution. The frontend's [image loader](https://github.com/OpenBeta/open-tacos/blob/develop/src/image-loader.js)
normally adds size/quality parameters for display.

Live introspection of `TickType` returned ID, user, name, notes, climb ID, style,
attempt type, date, grade, source, and climb fields, with no photo field.
`MediaWithTags` had user/media metadata and entity tags, with no tick field.
This matches the [Tick schema](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/graphql/schema/Tick.gql),
[Media schema](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/graphql/schema/Media.gql),
and current [tick editor](https://github.com/OpenBeta/open-tacos/blob/develop/src/components/users/TickForm.tsx).
The sampled photos had empty tag lists. A user gallery therefore cannot establish
which ascent, if any, a particular image depicts.

## Mountain Project: verified photo bytes, no tick link

Read both pages of the observed
[Cragmont Crack tick endpoint](https://www.mountainproject.com/api/v2/routes/105734660/ticks).
The pages contained 716 records in total. The union of returned fields was
`id`, `date`, `comment`, `style`, `leadStyle`, `pitches`, `text`, `createdAt`,
`updatedAt`, and `user`; there was no media field. These are undocumented
application responses, not a guaranteed upstream contract.

The [route page](https://www.mountainproject.com/route/105734660/cragmont-crack)
and its current JavaScript exposed a photo dialog at
`GET /ajax/public/photo?id=120604915`. That dialog returned an uploader, caption,
date, display variants, and an expansion link to
[`/photo/full/120604915`](https://www.mountainproject.com/photo/full/120604915).
Following the expansion link returned HTTP 200 and `image/jpeg`, redirecting
to the provider's `large` image variant. Use observed links; do not synthesize
an alleged original URL by replacing size suffixes.

The sample is a route photograph. Its uploader/date and route do not establish
a particular ascent. The photo dialog supplied no tick ID. The site's
[maintainer explanation](https://www.mountainproject.com/forum/topic/114250790/how-to-add-pictures-and-ticks-to-profile)
also distinguishes personal albums and route/area uploads from ticking routes;
that older explanation is context, not proof of current API capability.

## theCrag: documented candidates, live retrieval blocked

The current [personal logbook API guide](https://www.thecrag.com/en/article/logbookreadapi)
was readable through the browser and indexed documentation despite direct HTTP
requests receiving 403. It documents ascent `markdown` notes but no photo field.
An omission in documentation does not prove every live response lacks photos.

The separate [general API guide](https://www.thecrag.com/en/article/api)
documents `GET /api/photo/id/{id}` and photo facets, with application-key access.
Personal logbook keys must not be presumed to authorize that separate API.
No authenticated photo response was tested.

The [formatting guide](https://www.thecrag.com/en/article/formattingtext)
applies Markdown to ascent comments; the [embedding guide](https://www.thecrag.com/article/embedingimages)
documents standalone theCrag photo URLs as embeds. This suggests a concrete
candidate: extract an explicit photo reference from a particular ascent's notes
and resolve its metadata. A bare climb/user/date match is insufficient.

The [oEmbed guide](https://www.thecrag.com/en/article/oembed)
documents `/oembed` with `url` and optional `format=json`. Using its published
sample photo, the read-only request was:

```http
GET https://www.thecrag.com/oembed?url=https%3A%2F%2Fwww.thecrag.com%2Fphoto%2F521192313&format=json
```

It returned HTTP 403 with HTML, as did the public photo page. This is a concrete
retrieval blocker, not evidence of an expired user key. End-to-end validation
requires a real ascent with a photo embed, successful metadata resolution,
and successful retrieval of the resolved image. No challenge bypass or
alternative-host scraping was attempted.

## Design consequence and next evidence

KAYA remains the only inspected source with an explicit structured ascent-photo
field. OpenBeta and Mountain Project have verified photo download mechanisms
but no verified per-ascent association. Their user/climb photos could be a
separate product scope, preserving that ownership rather than guessing ticks.
theCrag has a documented notes/embed route that still needs live validation.

Before claiming all-provider ascent retrieval, obtain a provider-native ascent
with an attached photo and validate its association and image bytes for each
source. Preserve the distinction between metadata access, byte retrieval, and
ascent attribution in future provider audits.
