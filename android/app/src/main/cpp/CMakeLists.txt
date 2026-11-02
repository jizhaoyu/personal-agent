cmake_minimum_required(VERSION 3.22.1)
project("looma_guard")

add_library(
    looma_guard
    SHARED
    native_guard.cpp
)

find_library(
    log-lib
    log
)

target_link_libraries(
    looma_guard
    ${log-lib}
)
