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
  std::string request;
  while (std::getline(std::cin, request)) {
    try {
      // Valhalla's actor keeps request-local state. Recreate it for each
      // request so a failed matrix cannot corrupt the next one.
      valhalla::tyr::actor_t actor(config, false);
      const bool is_matrix = request.find("\"sources\"") != std::string::npos &&
                             request.find("\"targets\"") != std::string::npos;
      std::cout << (is_matrix ? actor.matrix(request) : actor.route(request)) << '\n';
    } catch (const std::exception& error) {
      std::cout << "{\"error\":\"" << error.what() << "\"}" << '\n';
    }
    std::cout.flush();
  }
  return 0;
}
