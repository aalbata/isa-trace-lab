"""Independent reference evaluator for the ISA Trace Lab source language.

The evaluator is written from the language specification (docs/language.md)
and shares no code with the TypeScript implementation: it parses the program
with CPython's own `ast` module and evaluates the tree with explicit 32-bit
wraparound. It also reports whether any exact intermediate value left the
signed 32-bit range; when none did and no runtime error occurred, the program
must behave identically under ordinary Python integers, which `run_cpython`
checks by executing the program directly.
"""
import ast

INT_MIN = -(1 << 31)
INT_MAX = (1 << 31) - 1
TRAP_INDEX = 1
TRAP_SHIFT = 2


class Trap(Exception):
    def __init__(self, code, line):
        super().__init__(code)
        self.code = code
        self.line = line


class StepLimit(Exception):
    pass


class _Break(Exception):
    pass


class _Continue(Exception):
    pass


class _Return(Exception):
    def __init__(self, value):
        super().__init__()
        self.value = value


class Evaluator:
    def __init__(self, source, max_steps=5_000_000):
        tree = ast.parse(source)
        self.main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
        self.max_steps = max_steps
        self.vars = {}
        self.arrays = {}
        self.output = []
        self.steps = 0
        self.in_range = True

    def wrap(self, z):
        if z < INT_MIN or z > INT_MAX:
            self.in_range = False
            z &= 0xFFFFFFFF
            if z & 0x80000000:
                z -= 1 << 32
        return z

    def tick(self):
        self.steps += 1
        if self.steps > self.max_steps:
            raise StepLimit()

    # ---- expressions ---------------------------------------------------------

    def binary(self, op, a, b, line):
        if isinstance(op, ast.Add):
            return self.wrap(a + b)
        if isinstance(op, ast.Sub):
            return self.wrap(a - b)
        if isinstance(op, ast.Mult):
            return self.wrap(a * b)
        if isinstance(op, ast.BitAnd):
            return self.wrap(a & b)
        if isinstance(op, ast.BitOr):
            return self.wrap(a | b)
        if isinstance(op, ast.BitXor):
            return self.wrap(a ^ b)
        if isinstance(op, (ast.LShift, ast.RShift)):
            if b < 0 or b > 31:
                raise Trap(TRAP_SHIFT, line)
            return self.wrap(a << b) if isinstance(op, ast.LShift) else self.wrap(a >> b)
        raise ValueError("operator outside the language: " + type(op).__name__)

    def literal(self, node):
        """Exact value of an integer literal with any number of unary signs."""
        sign = 1
        while isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            if isinstance(node.op, ast.USub):
                sign = -sign
            node = node.operand
        return sign * node.value

    def element(self, node):
        values = self.arrays[node.value.id]
        index = self.expr(node.slice)
        if index < 0 or index >= len(values):
            raise Trap(TRAP_INDEX, node.lineno)
        return values, index

    def expr(self, node):
        if isinstance(node, ast.Constant):
            if node.value is True or node.value is False:
                return node.value
            return self.wrap(node.value)
        if isinstance(node, ast.Name):
            return self.vars[node.id]
        if isinstance(node, ast.UnaryOp):
            v = self.expr(node.operand)
            if isinstance(node.op, ast.USub):
                return self.wrap(-v)
            if isinstance(node.op, ast.UAdd):
                return v
            if isinstance(node.op, ast.Invert):
                return self.wrap(-v - 1)
            if isinstance(node.op, ast.Not):
                return not v
        if isinstance(node, ast.BinOp):
            a = self.expr(node.left)
            b = self.expr(node.right)
            return self.binary(node.op, a, b, node.lineno)
        if isinstance(node, ast.BoolOp):
            if isinstance(node.op, ast.And):
                for v in node.values:
                    if not self.expr(v):
                        return False
                return True
            for v in node.values:
                if self.expr(v):
                    return True
            return False
        if isinstance(node, ast.Compare):
            a = self.expr(node.left)
            b = self.expr(node.comparators[0])
            op = node.ops[0]
            if isinstance(op, ast.Eq):
                return a == b
            if isinstance(op, ast.NotEq):
                return a != b
            if isinstance(op, ast.Lt):
                return a < b
            if isinstance(op, ast.LtE):
                return a <= b
            if isinstance(op, ast.Gt):
                return a > b
            if isinstance(op, ast.GtE):
                return a >= b
        if isinstance(node, ast.Call) and node.func.id == "len":
            return len(self.arrays[node.args[0].id])
        if isinstance(node, ast.Subscript):
            values, index = self.element(node)
            return values[index]
        raise ValueError("expression outside the language: " + ast.dump(node))

    # ---- statements ----------------------------------------------------------

    def block(self, stmts):
        for s in stmts:
            self.stmt(s)

    def stmt(self, s):
        self.tick()
        if isinstance(s, ast.Pass):
            return
        if isinstance(s, ast.Break):
            raise _Break()
        if isinstance(s, ast.Continue):
            raise _Continue()
        if isinstance(s, ast.Return):
            raise _Return(None if s.value is None else self.expr(s.value))
        if isinstance(s, ast.Expr):
            value = self.expr(s.value.args[0])
            self.output.append(value)
            return
        if isinstance(s, ast.Assign):
            target = s.targets[0]
            if isinstance(s.value, ast.List):
                self.arrays[target.id] = [self.expr(e) for e in s.value.elts]
                return
            if isinstance(s.value, ast.BinOp) and isinstance(s.value.left, ast.List):
                fill = self.expr(s.value.left.elts[0])
                self.arrays[target.id] = [fill] * s.value.right.value
                return
            value = self.expr(s.value)
            if isinstance(target, ast.Subscript):
                values, index = self.element(target)
                values[index] = value
            else:
                self.vars[target.id] = value
            return
        if isinstance(s, ast.AugAssign):
            if isinstance(s.target, ast.Subscript):
                values, index = self.element(s.target)
                old = values[index]
                values[index] = self.binary(s.op, old, self.expr(s.value), s.lineno)
            else:
                old = self.vars[s.target.id]
                self.vars[s.target.id] = self.binary(s.op, old, self.expr(s.value), s.lineno)
            return
        if isinstance(s, ast.If):
            self.block(s.body if self.expr(s.test) else s.orelse)
            return
        if isinstance(s, ast.While):
            while True:
                if not self.expr(s.test):
                    return
                try:
                    self.block(s.body)
                except _Break:
                    return
                except _Continue:
                    pass
                self.tick()
        if isinstance(s, ast.For):
            bounds = [self.expr(a) for a in s.iter.args[:2]]
            # The step is an integer literal. The language steps by its 32-bit value, which differs
            # from Python's exact value, and so leaves the range, only when the exact value does not fit.
            step = self.wrap(self.literal(s.iter.args[2])) if len(s.iter.args) == 3 else 1
            sequence = range(*bounds, step) if len(bounds) == 2 else range(0, bounds[0], step)
            for value in sequence:
                self.vars[s.target.id] = value
                try:
                    self.block(s.body)
                except _Break:
                    return
                except _Continue:
                    pass
                self.tick()
            return
        raise ValueError("statement outside the language: " + type(s).__name__)

    def run(self, args):
        for p, value in zip(self.main.args.args, args):
            self.vars[p.arg] = value
        result = {"status": "exited", "returnValue": 0, "trapCode": None, "trapLine": None, "implicitReturn": True}
        try:
            self.block(self.main.body)
        except _Return as r:
            if r.value is not None:
                result["returnValue"] = r.value
                result["implicitReturn"] = False
        except Trap as t:
            result.update(status="trap", returnValue=None, trapCode=t.code, trapLine=t.line)
        except StepLimit:
            result.update(status="limit", returnValue=None)
        result["output"] = self.output
        result["inRange"] = self.in_range and result["status"] == "exited"
        return result


def run_reference(source, args, max_steps=5_000_000):
    return Evaluator(source, max_steps).run(args)


def run_cpython(source, args):
    """Execute the program with ordinary Python integers and return its output and result."""
    output = []
    namespace = {"print": lambda value: output.append(value)}
    exec(compile(source, "<corpus>", "exec"), namespace)
    value = namespace["main"](*args)
    return {"output": output, "returnValue": 0 if value is None else value}
