# A Meson fixture, as meson format formats it.
project(
    'edwin',
    'c',
    version: '1.0',
    default_options: ['warning_level=3', 'c_std=c11', 'buildtype=release'],
)

srcs = files('a.c', 'b.c')
deps = [
    dependency('glib-2.0'),
    dependency('gtk4', required: get_option('gui')),
    dependency('threads'),
]

if host_machine.system() == 'linux'
    add_project_arguments('-DLINUX', language: 'c')
elif host_machine.system() == 'darwin'
    add_project_arguments('-DDARWIN', language: 'c')
else
    error('unsupported')
endif

foreach name : ['one', 'two']
    if name == 'one'
        message(name)
    endif
endforeach

conf = {
    'a': 1,
    'b': 'ünïcode',
}

text = '''
  a multi-line string,
    its blanks kept
'''

executable(
    'edwin',
    srcs,
    dependencies: deps,
    install: true,
    c_args: ['-Wall', '-Wextra', '-Werror'],
)
