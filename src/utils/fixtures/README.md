Fixture provenance:

- agy-pong-failed.ndjson is stdout captured on 2026-10-29 from the one permitted tiny run, in a temp directory, with the exact flags and prompt requested. No init event was emitted. Stderr contained profile write denials, authentication errors and network failures; it is omitted to keep unrelated diagnostic noise out of the fixture.
- The installed binary's diagnostics reported 1.4.10. The sandbox denied writes to the CLI profile and blocked network access; authentication/model resolution failed before init.
- agy-stream-spec.ndjson and agy-denied-spec.* are synthetic fixtures based on the v3 spike shapes supplied in the design spec/user request. They are NOT successful captures from this environment. Replace the success fixture with a real agy 1.4.9 capture when available.
