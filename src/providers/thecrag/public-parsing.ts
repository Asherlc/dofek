import {
  FREE_ROCK_GRADE_SYSTEMS,
  type GradeSystem,
  isGradeSystemForClimbKind,
  isValidClimbingGrade,
} from "@dofek/training/climbing-grades";
import type { ClimbKind, GradeComponent } from "@dofek/training/climbing-log";
import { load } from "cheerio";
import sax from "sax";
import { z } from "zod";
import type { SourceClimbingAttempt, SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";
import { captureException } from "../../lib/error-reporting.ts";

const ORIGIN = "https://www.thecrag.com";
const numericId = z.string().regex(/^[1-9]\d*$/);
const usernameSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);

export function publicProfileUsername(input: string): string {
  const trimmed = input.trim();
  if (usernameSchema.safeParse(trimmed).success) return trimmed;
  const url = URL.canParse(trimmed) ? new URL(trimmed) : null;
  const match = url?.pathname.match(/^\/(?:en\/)?(?:climber|ascents\/by)\/([a-zA-Z0-9_-]+)\/?$/);
  if (
    !url ||
    url.origin !== ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match?.[1]
  ) {
    throw new Error(
      "Enter your public theCrag username or https://www.thecrag.com/climber/username profile URL.",
    );
  }
  return match[1];
}

export function publicProfileAccount(body: unknown, username: string): string {
  const parsed = z
    .object({ data: z.array(z.object({ id: numericId, login: z.string() })) })
    .safeParse(body);
  const matches = parsed.success
    ? parsed.data.data.filter((account) => account.login === username)
    : [];
  if (matches.length !== 1 || !matches[0])
    throw new Error(
      "theCrag could not verify this public profile account. Check your exact username and try again.",
    );
  return matches[0].id;
}

export interface PublicAscentReference {
  id: string;
  accountId: string;
  routeId: string;
}

export function publicFeedUrl(accountId: string): string {
  return `${ORIGIN}/feed/ascents/climber/${accountId}`;
}

function verifiedFeedUrl(value: string, accountId: string): string {
  const url = URL.canParse(value, ORIGIN) ? new URL(value, ORIGIN) : null;
  if (
    !value ||
    !url ||
    url.origin !== ORIGIN ||
    url.pathname !== `/feed/ascents/climber/${accountId}` ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== "paginateAt") ||
    url.searchParams.getAll("paginateAt").length > 1 ||
    (url.search && !numericId.safeParse(url.searchParams.get("paginateAt")).success)
  ) {
    throw new Error(
      "theCrag returned an invalid public feed pagination URL. Try again or contact support.",
    );
  }
  return url.href;
}

export function parsePublicFeed(
  xml: string,
  accountId: string,
): { items: PublicAscentReference[]; next: string | null } {
  try {
    const parser = sax.parser(true, { xmlns: true });
    parser.ondoctype = () => {
      throw new Error("DTD not supported");
    };
    parser.write(xml).close();
  } catch {
    const error = new Error(
      "theCrag returned a malformed public Atom feed. Try again or contact support.",
    );
    captureException(error, { tags: { provider: "thecrag", phase: "public_feed" } });
    throw error;
  }
  const $ = load(xml, { xml: true });
  const feed = $("feed");
  if (
    feed.length !== 1 ||
    feed.attr("xmlns") !== "http://www.w3.org/2005/Atom" ||
    $(":root").length !== 1 ||
    feed.children("id").length !== 1
  )
    throw new Error("theCrag returned an invalid public Atom feed.");
  const identity = verifiedFeedUrl(feed.children("id").text().trim(), accountId);
  if (new URL(identity).search)
    throw new Error("theCrag returned an invalid public feed identity.");
  const nextLinks = feed.children('link[rel="next"]');
  if (nextLinks.length > 1)
    throw new Error("theCrag returned conflicting public feed pagination links.");
  const next = nextLinks.length ? verifiedFeedUrl(nextLinks.attr("href") ?? "", accountId) : null;
  const items: PublicAscentReference[] = [];
  for (const entry of feed.children("entry").toArray()) {
    const content = $(entry).children('content[type="html"]');
    if (content.length !== 1)
      throw new Error("theCrag returned an unsupported public ascent event.");
    const html = load(content.text());
    const events = html(".event-item");
    if (events.length === 0)
      throw new Error("theCrag returned an ascent event without public ascent identities.");
    for (const event of events.toArray()) {
      const element = html(event);
      const id = element.attr("data-ascent-id");
      const owner = element.attr("data-ascent-uid");
      const routeId = element.attr("data-node-id");
      if (
        !numericId.safeParse(id).success ||
        !numericId.safeParse(routeId).success ||
        owner !== accountId ||
        !id ||
        !routeId
      )
        throw new Error(
          "theCrag returned mismatched public ascent account or identifiers. Reconnect your intended account in Data Sources.",
        );
      const routeUrl = element.attr("data-route-url");
      if (routeUrl && routeIdFromUrl(routeUrl) !== routeId)
        throw new Error("theCrag returned mismatched public route identifiers.");
      items.push({ id, accountId, routeId });
    }
  }
  return { items, next };
}

function routeIdFromUrl(value: string): string | undefined {
  const url = URL.canParse(value, ORIGIN) ? new URL(value, ORIGIN) : null;
  if (!url || url.origin !== ORIGIN || url.username || url.password) return undefined;
  return /\/route\/([1-9]\d*)\/?$/.exec(url.pathname)?.[1];
}

function recordedRopeMethod(value: string): SourceClimbingAttempt["ropeMethod"] {
  if (/^(top rope|top-rope)( solo)?$/.test(value)) return "top_rope";
  if (/^lead( solo)?$/.test(value)) return "lead";
  if (/^(free solo|solo|unroped)$/.test(value)) return "unroped";
  if (/^(follow|second)$/.test(value)) return "follow";
  return null;
}

export function parsePublicAscent(
  html: string,
  reference: PublicAscentReference,
  username: string,
): SourceClimbingLogEntry {
  const $ = load(html);
  const ascentDetails = $("fieldset").filter(
    (_i, element) => $(element).children("legend").text().trim() === "Ascent details",
  );
  if (ascentDetails.length !== 1)
    throw new Error(
      "theCrag returned a blocked or unavailable public ascent page. Try again when public access is available.",
    );
  const fields = new Map<string, ReturnType<typeof $>>();
  for (const term of ascentDetails.find("dt").toArray()) {
    const label = $(term).text().trim();
    if (fields.has(label)) throw new Error("theCrag returned duplicate public ascent fields.");
    const value = $(term).next("dd");
    if (!value.length) throw new Error("theCrag returned an invalid public ascent field.");
    fields.set(label, value);
  }
  const ownerLink = fields.get("Account")?.find(".climber a").attr("href");
  if (!ownerLink || publicProfileUsername(new URL(ownerLink, ORIGIN).href) !== username)
    throw new Error(
      "theCrag returned a different public ascent account. Reconnect your intended account.",
    );
  const canonical = $('link[rel="canonical"]').attr("href");
  const canonicalUrl =
    canonical && URL.canParse(canonical, ORIGIN) ? new URL(canonical, ORIGIN) : null;
  if (
    (!canonicalUrl && !$("#msgf_ref").attr("value")) ||
    (canonicalUrl &&
      (canonicalUrl.origin !== ORIGIN ||
        !new RegExp(`^/(?:en/)?ascent/${reference.id}/?$`).test(canonicalUrl.pathname)))
  )
    throw new Error("theCrag returned a different public ascent identity.");
  const pageAscentId = $("#msgf_ref").attr("value");
  if (pageAscentId && pageAscentId !== reference.id)
    throw new Error("theCrag returned a different public ascent identity.");
  const route = fields.get("Route")?.find(".route a");
  if (route?.length !== 1 || routeIdFromUrl(route.attr("href") ?? "") !== reference.routeId)
    throw new Error("theCrag returned a different public route identity.");
  const dateElement = fields.get("Ascent date");
  const date =
    dateElement?.find("[datetime]").attr("datetime") ??
    dateElement?.find("[data-date]").attr("data-date") ??
    dateElement?.text().trim();
  const day = date?.slice(0, 10);
  if (
    !date ||
    !day ||
    day.startsWith("0000-") ||
    !z.iso.date().safeParse(day).success ||
    !(
      z.iso.date().safeParse(date).success ||
      z.iso.datetime({ offset: true, local: true }).safeParse(date).success
    )
  )
    throw new Error(
      `theCrag ascent ${reference.id} has an incomplete or invalid climb date. Record the exact climb day in theCrag and sync again.`,
    );
  const text = (key: string) => fields.get(key)?.text().trim();
  const style = (key: string) => fields.get(key)?.find(".tags").text().trim().toLowerCase() ?? "";
  const climbedStyle = style("Climbed gear style");
  const routeStyle = style("Route gear style");
  const tick = fields.get("Tick")?.find("[title]").first().attr("title")?.trim() ?? text("Tick");
  if (!tick)
    throw new Error(
      `theCrag ascent ${reference.id} has no public tick result. Check the ascent in theCrag.`,
    );
  const styles = [climbedStyle, routeStyle];
  const isBoulder = styles.includes("boulder");
  const sourceResult = tick.split(":")[0]?.trim() ?? "";
  const result = sourceResult.toLowerCase();
  const suffix = tick.includes(":")
    ? tick
        .slice(tick.indexOf(":") + 1)
        .trim()
        .toLowerCase()
    : "";
  const methodSources = [result, suffix, climbedStyle];
  const methods = new Set(methodSources.map(recordedRopeMethod).filter((method) => method != null));
  const climbedMethod = recordedRopeMethod(climbedStyle);
  if (methods.size > 1)
    throw new Error(
      `theCrag ascent ${reference.id} has conflicting recorded climbing methods. Review the tick and climbed gear style in theCrag.`,
    );
  const ropeMethod = methods.values().next().value ?? null;
  const hasRockRouteStyle = styles.some((value) =>
    ["sport", "trad", "aid", "top rope", "top-rope"].includes(value),
  );
  const isRoute = methods.size > 0 || hasRockRouteStyle;
  if (isBoulder && isRoute)
    throw new Error(`theCrag ascent ${reference.id} has an inconsistent climbing discipline.`);
  const kind: ClimbKind | null = isBoulder ? "boulder" : isRoute ? "route" : null;
  if (!isBoulder && !ropeMethod)
    throw new Error(
      `theCrag ascent ${reference.id} has no recorded climbing method. Record lead, top rope, or solo in theCrag and sync again.`,
    );
  const usedAid =
    climbedStyle === "aid" ||
    result.startsWith("aid ") ||
    ["french free", "frenchfree"].includes(result);
  const qualifier = sourceQualifier(result, usedAid);
  const attempt: SourceClimbingAttempt = {
    scope: "climb",
    sourceResult,
    ...(ropeMethod ? { ropeMethod } : {}),
    ...(methodSources.some((value) => recordedRopeMethod(value) != null && value.includes("solo"))
      ? { solo: true }
      : {}),
    ...(climbedStyle === "sport" || climbedStyle === "trad"
      ? { protectionUsed: [climbedStyle] }
      : {}),
    ...(qualifier ? { qualifier } : {}),
    ...(usedAid ? { usedAid: true } : {}),
    ...(["dog", "hang dog"].includes(result) ? { fellOrHung: true } : {}),
    ...(result === "repeat" ? { hadCompletedBefore: true } : {}),
    ...(result === "ground-up redpoint" ? { priorFailedAttemptsGroundUp: true } : {}),
    ...(result === "pinkpoint" ? { usedPreplacedProtection: true } : {}),
  };
  const count = text("Attempts");
  if (count && (!/^[1-9]\d*$/.test(count) || !Number.isSafeInteger(Number(count))))
    throw new Error(`theCrag ascent ${reference.id} has an invalid reported attempt count.`);
  const attempts: SourceClimbingAttempt[] = [attempt];
  if (!isBoulder && count && Number(count) > 1) {
    if (!climbedMethod)
      throw new Error(
        `theCrag ascent ${reference.id} has no recorded climbing method for its reported attempt total. Record the ascent-wide method in theCrag and sync again.`,
      );
    // The source reports a total, not individual try outcomes. Only its
    // ascent-wide method is known for these canonical count placeholders.
    for (let index = 1; index < Number(count); index++)
      attempts.push({ scope: "climb", ropeMethod: climbedMethod });
  }
  const published = text("Route grade");
  const reported = text("Ascent grade");
  const supplied = (value: string | undefined) => value && value !== "-- Inherits from route --";
  const noteElement = fields.get("Comment")?.find(".markdown").clone();
  noteElement?.find("br").replaceWith("\n");
  noteElement?.find("p").append("\n");
  const note = noteElement?.text().trim();
  const name = route.clone().find(".star").remove().end().text().trim();
  const provenance = Object.fromEntries(
    [...fields].map(([key, value]) => [key, value.text().trim()]),
  );
  return {
    externalId: `thecrag:${reference.id}`,
    climbedOn: day,
    sourceName: "theCrag",
    ...(isBoulder || hasRockRouteStyle ? { discipline: "rock_climbing" } : {}),
    attempts,
    ...(count ? { reportedAttemptCounts: [{ scope: "climb", count: Number(count) }] } : {}),
    ...(note ? { notes: note } : {}),
    ...(reported === "-- Inherits from route --"
      ? { reportedGrades: [] }
      : supplied(reported)
        ? { reportedGrades: sourceGrade(reported, kind, reference.id) }
        : {}),
    raw: {
      accountId: reference.accountId,
      ascentId: reference.id,
      routeId: reference.routeId,
      publicFields: provenance,
      tick,
    },
    climb: {
      externalId: reference.routeId,
      ...(name ? { name } : {}),
      ...(kind ? { kind } : {}),
      ...(routeStyle === "sport" || routeStyle === "trad" ? { routeProtection: [routeStyle] } : {}),
      ...(supplied(published)
        ? { publishedGrades: sourceGrade(published, kind, reference.id) }
        : {}),
    },
  };
}
function sourceGrade(
  rawGrade: string | null | undefined,
  kind: ClimbKind | null,
  ascentId: string,
): GradeComponent[] {
  let grade = rawGrade?.trim() ?? "";
  if (grade === "") return [];
  const components =
    /^(?:V(?:B|\d)|5\.|(?:FR|FB|AU|UIAA|YDS|BLDV|AID|AIDC|WICE|AICE|MIXED|IFAS|NCCS|UK|UKT)(?:\s*:\s*|\s+))/i.test(
      grade,
    )
      ? grade.split(
          /\s+(?=(?:FR|FB|AU|UIAA|YDS|BLDV|AID|AIDC|WICE|AICE|MIXED|IFAS|NCCS|UK|UKT)(?:\s*:\s*|\s+))/i,
        )
      : [grade];
  if (components.length > 1)
    return components.flatMap((component) => sourceGrade(component, kind, ascentId));
  let gradeSystem: GradeSystem | null = null;
  if (/^V(?:B|\d+)(?:[+-])?$/i.test(grade)) gradeSystem = "v_scale";
  else if (/^5\./.test(grade)) gradeSystem = "yds";
  else {
    // theCrag documents these scale labels. gradeAtom.type is undocumented.
    const explicitScale =
      /^(FR|FB|AU|UIAA|YDS|BLDV|AID|AIDC|WICE|AICE|MIXED|IFAS|NCCS|UK|UKT)(?:\s*:\s*|\s+)(.+)$/i.exec(
        grade,
      );
    if (explicitScale) {
      switch (explicitScale[1]?.toUpperCase()) {
        case "FR":
          gradeSystem = "french";
          break;
        case "FB":
          gradeSystem = "font";
          break;
        case "AU":
          gradeSystem = "ewbank";
          break;
        case "UIAA":
          gradeSystem = "uiaa";
          break;
        case "YDS":
          gradeSystem = "yds";
          break;
        case "BLDV":
          gradeSystem = "v_scale";
          break;
        case "AID":
        case "AIDC":
          gradeSystem = "aid";
          break;
        case "WICE":
          gradeSystem = "water_ice";
          break;
        case "AICE":
          gradeSystem = "alpine_ice";
          break;
        case "MIXED":
          gradeSystem = "mixed";
          break;
        case "IFAS":
          gradeSystem = "ifas";
          break;
        case "NCCS":
          gradeSystem = "nccs";
          break;
        case "UK":
          gradeSystem = "british_adjectival";
          break;
        case "UKT":
          gradeSystem = "british_technical";
          break;
      }
      grade = explicitScale[2]?.trim() ?? grade;
    }
  }
  if (
    gradeSystem !== null &&
    (kind === "boulder" || kind === "route") &&
    FREE_ROCK_GRADE_SYSTEMS.some((system) => system === gradeSystem) &&
    !isGradeSystemForClimbKind(gradeSystem, kind)
  ) {
    throw new Error(
      `theCrag ascent ${ascentId} has an unsupported or ambiguous grade. Use a grade with an explicit supported scale in theCrag, or contact support before syncing this logbook.`,
    );
  }
  if (gradeSystem !== null && !isValidClimbingGrade(grade, gradeSystem)) {
    gradeSystem = null;
    grade = rawGrade?.trim() ?? "";
  }
  return [{ system: gradeSystem, value: grade }];
}

function sourceQualifier(value: string | null, aid: boolean): SourceClimbingAttempt["qualifier"] {
  switch (value?.trim().toLowerCase()) {
    case "aid onsight":
    case "onsight":
    case "on sight":
      return aid ? "aid-onsight" : "free-onsight";
    case "aid flash":
    case "flash":
      return aid ? "aid-flash" : "free-flash";
    case "clean":
    case "send":
    case "redpoint":
    case "pinkpoint":
    case "greenpoint":
    case "repeat":
    case "ground-up redpoint":
      return aid ? undefined : "free-send";
    case "fell/hung":
      return "fell-hung";
    case "dab":
      return "dab";
    default:
      return undefined;
  }
}
