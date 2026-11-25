# Arrays whose offsets in the data region exceed the short offset fields.
def main(n):
    first = [1] * 4096
    second = [2] * 4096
    third = [7, 8, 9, 10]
    first[4095] = n
    second[0] = first[4095] + 1
    second[4095] = second[0] * 2
    third[3] = second[4095] - first[0]
    i = 4000
    while i < 4096:
        first[i] += i
        second[i] = first[i] ^ third[i & 3]
        i += 37
    print(third[3])
    print(second[4037])
    return first[4000] + second[4095] + third[0]
