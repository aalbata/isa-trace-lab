# Boolean variables in every assignment form.
def main(a, b):
    p = a < b
    q = not p
    r = p and b > 0
    s = q or a == 0
    t = not (p or s)
    u = True
    v = False
    w = not (a != b)
    x = s
    n = 0
    if p: n += 1
    if q: n += 2
    if r: n += 4
    if s: n += 8
    if t: n += 16
    if u: n += 32
    if v: n += 64
    if w: n += 128
    if x and not v: n += 256
    if not u or (p and q): n += 512
    return n
