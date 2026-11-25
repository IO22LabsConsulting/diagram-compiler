# Visual review rubric

Look at the PNG once, as a first-time reader. It passes when every answer is yes.

1. **Message.** Can you say what the diagram is about in one sentence after five seconds?
2. **Entry point.** Is it obvious where to start reading and which way it flows?
3. **Hierarchy.** Does the most important element stand out (one `primary`, not five)? In a grid, table or sequence the title and the order of panels, rows or steps carry this; no `primary` is needed.
4. **Readability.** Is every label short enough to read at a glance? No sentence-length labels. (Table cells may be a short phrase or clause.)
5. **Balance.** No one huge empty area, no one cramped corner, no single edge taking a long detour around everything.
6. **Colour.** Does each colour mean one thing? Would it still read in greyscale?
7. **Truth.** Does every arrow describe something that really happens in the source material?

If one fails, change the spec: shorten labels, cut secondary nodes or edges, add or remove a group,
flip `hints.direction`, mark a back-edge as `kind: "loop"`, split into a `grid`, or turn same-shaped panels into a `table`. Never edit the SVG.
