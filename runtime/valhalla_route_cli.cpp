#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>

#include <iostream>
#include <string>

#include <valhalla/tyr/actor.h>

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: valhalla_route_cli CONFIG\n";
    return 2;
  }
  boost::property_tree::ptree config;
  boost::property_tree::read_json(argv[1], config);
  valhalla::tyr::actor_t actor(config, false);
  std::string request;
  while (std::getline(std::cin, request)) {
    try {
      std::cout << actor.route(request) << '\n';
    } catch (const std::exception& error) {
      std::cout << "{\"error\":\"" << error.what() << "\"}" << '\n';
    }
    std::cout.flush();
  }
  return 0;
}
