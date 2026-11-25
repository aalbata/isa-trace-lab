# The right operand of and/or is evaluated only when needed.
def main(i):
    a = [5, 0, 9]
    hits = 0
    if i >= 0 and i < len(a) and a[i] > 0:
        hits += 1
    if i < 0 or i >= len(a) or a[i] == 0:
        hits += 10
    ok = i >= 0 and i < 3 and a[i] != 9
    if ok:
        hits += 100
    bad = not (i < 0 or i > 2) and a[i] < 6
    if bad:
        hits += 1000
    return hits
