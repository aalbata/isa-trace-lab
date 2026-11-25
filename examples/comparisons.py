# Comparisons stored as Boolean values, and short-circuit conditions.
def main(a, b):
    less = a < b
    same = a == b
    count = 0
    if less:
        count += 1
    if not same:
        count += 2
    if a >= 0 and b >= 0:
        count += 4
    if a > 100 or b > 100:
        count += 8
    between = a <= 5 and not (b != 7)
    if between:
        count += 16
    return count
