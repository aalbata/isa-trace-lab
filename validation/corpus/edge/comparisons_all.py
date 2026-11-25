# Every comparison operator with constants on either side.
def main(a, b):
    n = 0
    if a == b: n += 1
    if a != b: n += 2
    if a < b: n += 4
    if a <= b: n += 8
    if a > b: n += 16
    if a >= b: n += 32
    if 0 < a: n += 64
    if 5 >= b: n += 128
    if a == 2147483647: n += 256
    if -2147483648 == b: n += 512
    if a < -1: n += 1024
    if b > 100000: n += 2048
    if 3 != 3: n += 4096
    if 2 <= 2: n += 8192
    c = a >= 70000
    d = b <= -70000
    e = 10 > a
    f = a == 0
    if c: n += 16384
    if d: n += 32768
    if e: n += 65536
    if f: n += 131072
    return n
