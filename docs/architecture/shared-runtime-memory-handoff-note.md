---
status: authoritative
type: architecture
authority: canonical
implementation_status: planned
last_validated_against: issue-69
---

# Shared Runtime Memory and Handoff Note

## Purpose

This note records the Shared Runtime boundary for issue #69 without changing the broader Shared Runtime overview.

## Intended Shared Runtime Seams

The Shared Runtime may provide neutral services for:

- loading conversation turns and compact summaries;
- chunking and reducing un-compacted conversation turns;
- validating and storing persistent memory candidates;
- building provider-agnostic handoff context;
- tracking whether a CLI provider needs one-time handoff injection.

The Companion Runtime and Engineering Worker decide when those services are invoked and which compact profile to use.

## Boundary Rule

Shared Runtime may own generic memory and handoff primitives, but it must not own Companion-specific chat behavior or Engineering Worker-specific job, PR, review, or merge lifecycles.

## Canonical Reference

The canonical memory and handoff architecture is `docs/architecture/memory-and-handoff.md`.
