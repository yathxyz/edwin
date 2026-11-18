# A GDScript fixture, as gdformat --use-spaces=4 formats it.
extends Node2D
class_name Fixture

signal hit(damage)

enum State { IDLE, RUN, JUMP }

const SPEED := 200.0
@export var health: int = 100
var items := [
    "a fairly long string to break the line here",
    "another long string",
    "and one more for good measure"
]
var table := {"a": 1, "b": 2}


func _ready() -> void:
    if health > 50:
        print("healthy")
    elif health > 0:
        print("hurt")
    else:
        print("ünïcode")
    for i in range(3):
        if i == 1:
            continue
        print(i)
    while health > 0:
        health -= 1
    match health:
        0:
            print("zero")
        _:
            pass


func long_call(a, b):
    return some_function_with_a_long_name(a, b, "a long string argument", another_argument_name)


class Inner:
    var x := 1

    func f():
        return x


func longer(first_parameter_name, second_parameter_name, third_parameter_name, fourth_parameter):
    var result = some_function_with_a_long_name(
        first_parameter_name, second_parameter_name, "a string"
    )
    var d = {
        "first key": first_parameter_name, "second key": second_parameter_name, "third": 3, "x": 4
    }
    return result
