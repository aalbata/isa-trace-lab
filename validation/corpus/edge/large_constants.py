# Constants with different upper and lower bit patterns.
def main(x):
    t = 0
    t ^= x + 0x12345678
    t ^= x + 0x7FFFFFFF
    t ^= x + 0x80000000
    t ^= x + 0xFFFF0000
    t ^= x + 0x0000FFFF
    t ^= x + 0x00010000
    t ^= x + 0xFFFFF800
    t ^= x + 0x800
    t ^= x + 0x7FF
    t ^= x + 0xFFFFFFFF
    t ^= x - 2048
    t ^= x - 2049
    t ^= x & 0x00FF00FF
    t ^= x | 0x0F0F0F0F
    t ^= x ^ 0x55555555
    t ^= x & 0xAAAA5555
    t ^= x + 32767
    t ^= x + 32768
    t ^= x - 32768
    t ^= x - 32769
    t ^= x & 0xFFFF
    t ^= x & 0x1FFFE0
    t ^= x * 100000
    t ^= x + 4095
    t ^= x + 4096
    t ^= x + 16773120
    if x < 100000:
        t += 1
    if x == 0x12340000:
        t += 2
    if x > -65537:
        t += 4
    return t
