// src/core/seriesIndex/links.ts
import { describeReason } from '../errorReason.js';
import { itemUrl } from './collect.js';

/**
 * A link to the index on every volume, as its FIRST attachment (operator,
 * 2026-11-18). Checked live: a PUT with no staging area and the bean's
 * attachments reordered keeps every file and its uuid, and openEQUELLA's item
 * page lists them in that order.
 *
 * IDEMPOTENT: a volume that already has a link to THIS index page (matched by
 * url) is left alone when it is first, or moved to first keeping its uuid --
 * never given a second. Carries on past a failure and names it: one refused
 * volume must not leave the rest unlinked with nobody told.
 */

export interface LinkClient {
  getItemBean(uuid: string, version: number): Promise<Record<string, unknown>>;
  editItem(uuid: string, version: number, bean: Record<string, unknown>, stagingUuid?: string): Promise<void>;
}

export interface LinkResult {
  added: number;
  alreadyThere: number;
  failed: { heading: string; reason: string }[];
}

/**
 * The one result line, printed by the CLI and shown by the desktop. Names every
 * volume that was not linked, and says held-back volumes were never tried --
 * otherwise "Linked 37 volumes" reads as "every volume".
 */
export function linkLine(r: LinkResult, o: { group: string; groups: string; heldBack: number }): string {
  let line = `Linked ${r.added} ${r.added === 1 ? o.group : o.groups} to the index (${r.alreadyThere} already had it).`;
  if (r.failed.length > 0) line += ` Not linked: ${r.failed.map((f) => `${f.heading} -- ${f.reason}`).join('; ')}.`;
  if (o.heldBack > 0) line += ` Held-back ${o.groups} were not linked.`;
  return line;
}

export function indexPageUrl(base: string, indexUuid: string): string {
  return `${itemUrl(base, indexUuid)}index.html`;
}

export async function linkVolumes(
  client: LinkClient,
  volumes: readonly { uuid: string; version: number; heading: string }[],
  url: string,
  label: string,
): Promise<LinkResult> {
  const result: LinkResult = { added: 0, alreadyThere: 0, failed: [] };
  for (const v of volumes) {
    try {
      const bean = await client.getItemBean(v.uuid, v.version);
      const current = Array.isArray(bean['attachments']) ? (bean['attachments'] as Record<string, unknown>[]) : [];
      const at = current.findIndex((a) => a['type'] === 'url' && a['url'] === url);
      if (at === 0 && current[0]!['description'] === label) {
        result.alreadyThere += 1;
        continue;
      }
      const link = at === -1 ? { type: 'url', url, description: label } : { ...current[at]!, description: label };
      const rest = current.filter((_, i) => i !== at);
      await client.editItem(v.uuid, v.version, { ...bean, attachments: [link, ...rest] });
      result.added += 1;
    } catch (err) {
      result.failed.push({ heading: v.heading, reason: describeReason(err) });
    }
  }
  return result;
}
