import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildSnapshot, findLatestTokenEvent, parseSessionDetails } from "./parser";
import type { MonitorSnapshot, ParsedEvent } from "./types";

const TAIL_BYTES = 768 * 1024;
const HEAD_BYTES = 64 * 1024;
const CANDIDATE_COUNT = 24;

interface Candidate {
  path: string;
  modifiedAt: number;
}

interface EventCandidate {
  path: string;
  event: ParsedEvent;
  eventTime: number;
  tail: string;
}

export async function readLatestSnapshot(
  codexDirectory: string,
): Promise<MonitorSnapshot | undefined> {
  const files = await listCandidates(codexDirectory);
  const events = await Promise.all(files.map(readEventCandidate));
  const latest = events
    .filter((value): value is EventCandidate => Boolean(value))
    .sort((left, right) => right.eventTime - left.eventTime)[0];

  if (!latest) return undefined;

  const head = await readSlice(latest.path, 0, HEAD_BYTES);
  const details = parseSessionDetails(head, latest.tail);
  return buildSnapshot(latest.event, latest.path, details);
}

async function listCandidates(codexDirectory: string): Promise<Candidate[]> {
  const roots = [
    join(codexDirectory, "sessions"),
    join(codexDirectory, "archived_sessions"),
  ];
  const paths = (await Promise.all(roots.map(findJsonlFiles))).flat();
  const candidates = await Promise.all(
    paths.map(async (path): Promise<Candidate | undefined> => {
      try {
        const fileStat = await stat(path);
        return { path, modifiedAt: fileStat.mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );

  return candidates
    .filter((value): value is Candidate => Boolean(value))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, CANDIDATE_COUNT);
}

async function findJsonlFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(path);
      }),
    );
  }

  await visit(root);
  return results;
}

async function readEventCandidate(
  candidate: Candidate,
): Promise<EventCandidate | undefined> {
  try {
    const fileStat = await stat(candidate.path);
    const start = Math.max(0, fileStat.size - TAIL_BYTES);
    const tail = await readSlice(candidate.path, start, TAIL_BYTES);
    const event = findLatestTokenEvent(tail);
    if (!event?.timestamp) return undefined;

    const eventTime = Date.parse(event.timestamp);
    if (!Number.isFinite(eventTime)) return undefined;
    return { path: candidate.path, event, eventTime, tail };
  } catch {
    return undefined;
  }
}

async function readSlice(path: string, start: number, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
