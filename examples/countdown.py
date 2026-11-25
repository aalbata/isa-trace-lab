# A range with a negative step, with continue.
def main(start):
    printed = 0
    for i in range(start, 0, -2):
        if i == 5:
            continue
        print(i)
        printed += 1
    return printed
