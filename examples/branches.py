# Classify a number with if, elif, and else.
def main(n):
    if n < 0:
        kind = -1
    elif n == 0:
        kind = 0
    elif n < 10:
        kind = 1
    else:
        kind = 2
    print(kind)
    return kind * 10 + 1
