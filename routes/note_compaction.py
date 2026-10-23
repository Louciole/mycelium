"""Compaction of a note's operation log (routes/notes_sync.py): fewer, bigger operations with
the same effect, so a device opening the note for the first time replays less of its history.

Pure functions, without the database: what is safe to rewrite only depends on the operations
(static/crdt/: the server never merges the CRDT, it only knows which operations a later one
points at). Three rewrites, each one keeping every replica's note the same:

- **A field's older values go.** The value written by the highest (k, c) wins on every replica,
  whatever the order: the others never show. Nothing points at a "set".
- **A run of typing becomes one insert.** An insert continuing the previous insert of the same
  client in the same block (its parent is that insert's last character, right side, the next
  clocks) is the same tree as one insert of both texts. The merged insert takes the later
  one's place in the log, so a replica that already has the first part only gets the rest
  (FugueText.applyInsert skips the characters it has). Moving the first part later is only
  safe if nothing between the two points at its characters: a reference makes the run stop.
- **Consecutive deletes of a client in a block become one**, at the later one's place: what a
  delete removes existed before it, so it still does later, and deleting twice is harmless.

Every merged operation stays within the per-operation limits the clients apply.
"""


def utf16_len(text):
    """Length in UTF-16 code units: one CRDT character each (JS string indices)."""
    return len(text.encode("utf-16-le")) // 2


def _touched(op):
    """The id ranges (c, from, to) an operation points at."""
    if op["t"] == "ins":
        return [(op["p"][0], op["p"][1], op["p"][1])] if op.get("p") else []
    if op["t"] == "del":
        return [tuple(r) for r in op["r"]]
    return []


def _chars(op):
    """(c, from, to): the ids of the characters an insert created."""
    return op["c"], op["k"], op["k"] + utf16_len(op["x"]) - 1


def compact(rows, max_text, max_ranges, max_delete_span):
    """rows: [(seq, op)] in seq order (a contiguous part of the log). Returns (removed: set of
    seqs to delete, rewritten: {seq: the operation now stored there})."""
    current = dict(rows)
    removed = set()
    rewritten = {}

    def merge(before, seq, op):
        """The operation at `before` and the one at `seq` become `op`, stored at `seq`."""
        removed.add(before)
        rewritten.pop(before, None)
        current[seq] = op
        rewritten[seq] = op

    # Older values of each field: only the newest (k, c) counts
    newest = {}
    for seq, op in rows:
        if op["t"] != "set":
            continue
        key = (op["o"], op["f"])
        best = newest.get(key)
        if best is None or (op["k"], op["c"]) > (current[best]["k"], current[best]["c"]):
            if best is not None:
                removed.add(best)
            newest[key] = seq
        else:
            removed.add(seq)

    runs = {}      # (client, object) → seq of the insert a run of typing can continue
    deletes = {}   # (client, object) → seq of the client's last delete in that object
    for seq, op in rows:
        if seq in removed or op["t"] == "set":
            continue
        key = (op["c"], op["o"])
        if op["t"] == "ins":
            before = runs.get(key)
            if before is not None:
                a = current[before]
                c, first, last = _chars(a)
                if (op["s"] == "R" and op.get("p") == [c, last] and op["k"] == last + 1
                        and utf16_len(a["x"]) + utf16_len(op["x"]) <= max_text):
                    merge(before, seq, {**a, "x": a["x"] + op["x"]})
                    runs[key] = seq
                    continue
        # Runs whose characters this operation points at can't move past it anymore
        for (c, from_, to) in _touched(op):
            for run_key, run_seq in list(runs.items()):
                if run_key[1] != op["o"]:
                    continue
                rc, first, last = _chars(current[run_seq])
                if rc == c and from_ <= last and to >= first:
                    del runs[run_key]
        if op["t"] == "ins":
            runs[key] = seq
            continue
        before = deletes.get(key)
        if before is not None:
            ranges = current[before]["r"] + op["r"]
            if (len(ranges) <= max_ranges
                    and sum(to - from_ + 1 for _c, from_, to in ranges) <= max_delete_span):
                merge(before, seq, {**op, "r": ranges})
        deletes[key] = seq
    return removed, rewritten
