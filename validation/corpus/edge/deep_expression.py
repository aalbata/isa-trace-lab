# Right-nested expressions keep many temporaries live at once.
def main(a, b, c, d):
    x = ((a * b) + ((b * c) + ((c * d) + ((d * a) + (((a + c) * (b + d)) + (((a - b) * (c - d)) + (((a ^ b) * (c | d)) + (((a & d) * (b + 1)) + ((a * 7) + ((b * (c + 3)) + ((d * d) + (c - a))))))))))))
    y = (a - 1) - ((b - 2) - ((c - 3) - ((d - 4) - ((a - 5) - ((b - 6) - ((c - 7) - ((d - 8) - ((a - 9) - ((b - 10) - (c - 11))))))))))
    print(x)
    print(y)
    return x ^ y
