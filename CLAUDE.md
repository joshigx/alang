see alang-specs.md for purpose of this projects

## language
write new things in english, everytime you encounter german, translate it

## goal
- Build a thin vertical slice first: parser, canonical text output and TypeScript output for Hello World and net.port.parse, before any checker exists. After that come type checking, effects, examples, and finally the database.
- Defer the two expensive rules. The static proof from 5.2 and the prefix check from 1.6 are each projects of their own. Start with runtime checks for all contracts.
- Expect gaps. The sketch leaves many things open: the exact form of const and extern fn, the standard library, comments and string escapes. Decide such cases according to the six principles.

- Two tests pay off from the start:
	- the examples from the specification as the first test cases,
	- the round trip "parse, print, parse again yields the same" as a guard over the canonical form


## MCP server
You don't need one at the start. The most important one emerges from the project itself: as soon as the queries and operations from section 6 exist, wrap them as an MCP server. Then Claude Code edits alang programs through context and replace, exactly as the specification intends, and the language gets tested along the way on its actual user.
