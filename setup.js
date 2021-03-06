// JS script to automate conversion of region mapping from geoserver to Tessera server
// Pass regionMapping.json as follows:
//
//    node setup.js path/to/regionMapping.json
//
'use strict';

var exec = require('child_process').exec;

var when = require('when');
var nodefn = require('when/node');
var guard = require('when/guard');
var fs = require('fs');
var path = require('path');
var binary = require('node-pre-gyp');
var shapefile = require('shapefile');
var merc = new (require('sphericalmercator'))();

// Promise versions of node-style functions
fs.writeFilePromise = nodefn.lift(fs.writeFile);
var execPromise = nodefn.lift(exec);


var const_maxZ = 20;
var const_minZ = 0;
var const_maxGenZ = 10;

var const_parallel_limit = 3;

var steps = {
    reprojection: false,
    tileGeneration: false,
    config: true
}


var directory = 'data2/';
var shapefile_dir = 'geoserver_shapefiles/';
var gdal_env_setup = /*'';//*/ '"C:\\Program Files\\GDAL\\GDALShell.bat" && ';

// From mapnik/bin/mapnik-shapeindex.js
var shapeindex = path.join(path.dirname( binary.find(require.resolve('mapnik/package.json')) ), 'shapeindex');

// From Mozilla MDN. Polyfill for old Node versions
if (typeof Object.assign != 'function') {
  (function () {
    Object.assign = function (target) {
      if (target === undefined || target === null) {
        throw new TypeError('Cannot convert undefined or null to object');
      }

      var output = Object(target);
      for (var index = 1; index < arguments.length; index++) {
        var source = arguments[index];
        if (source !== undefined && source !== null) {
          for (var nextKey in source) {
            if (source.hasOwnProperty(nextKey)) {
              output[nextKey] = source[nextKey];
            }
          }
        }
      }
      return output;
    };
  })();
}


var data_xml_template = fs.readFileSync('data.xml.template', 'utf8'); // Use shapefile template
function generateDataXml(layerName, bbox, pgsql_db) {
    return data_xml_template.replace(/\{layerName\}/g, layerName).replace(/\{bbox\}/g, bbox.join(',')); // Have to use regex for global (g) option (like sed)
}

function processLayer(layerName) {
    var layerDir = directory + layerName + '/';
    var hybridJsonFile = layerDir + 'hybrid.json';
    var dataXmlFile = layerDir + 'data.xml';
    var mbtilesFile = layerDir + 'store.mbtiles';
    var returnData = {};

    return when().then(function() {
        // Reproject to EPSG:3857
        if (!steps.reproject) return;
        console.log('Converting ' + layerName + ' to Web Mercator projection');
        return execPromise(gdal_env_setup + 'ogr2ogr -t_srs EPSG:3857 -clipsrc -180 -85.0511 180 85.0511 -overwrite -f "ESRI Shapefile" ' + layerDir.slice(0,-1) + ' ' + shapefile_dir + layerName + '.shp');
    }).then(function() {
        // Get info from new shapefile
        if (!steps.config) return;
        var reader = shapefile.reader(layerDir + layerName + '.shp');

        // Get header and then the first record and return both
        return nodefn.call(reader.readHeader.bind(reader)).then(function(header) {
            return when.join(header, nodefn.call(reader.readRecord.bind(reader)));
        });
    }).then(function(shapeinfo) {
        // Create config.json and regionMapping.json entry
        if (!steps.config) return;
        var header = shapeinfo[0];
        var record = shapeinfo[1];

        // Adapted from Cesium ImageryLayerFeatureInfo.js (https://github.com/AnalyticalGraphicsInc/cesium/blob/1.19/Source/Scene/ImageryLayerFeatureInfo.js#L57)
        // ================================================================================
        var namePropertyPrecedence = 10;
        var nameProperty;

        for (var key in record.properties) {
            if (record.properties.hasOwnProperty(key) && record.properties[key]) {
                var lowerKey = key.toLowerCase();

                if (namePropertyPrecedence > 1 && lowerKey === 'name') {
                    namePropertyPrecedence = 1;
                    nameProperty = key;
                } else if (namePropertyPrecedence > 2 && lowerKey === 'title') {
                    namePropertyPrecedence = 2;
                    nameProperty = key;
                } else if (namePropertyPrecedence > 3 && /name/i.test(key)) {
                    namePropertyPrecedence = 3;
                    nameProperty = key;
                } else if (namePropertyPrecedence > 4 && /title/i.test(key)) {
                    namePropertyPrecedence = 4;
                    nameProperty = key;
                }
            }
        }
        // ================================================================================

        var bbox = merc.convert(header.bbox, "WGS84");
        returnData = {
            layerName: layerName,
            config: {source: "hybrid://" + path.resolve(hybridJsonFile), minZ: const_minZ, maxZ: const_maxZ},
            regionMapping: {
                layerName: layerName,
                server: "http://127.0.0.1:8000/" + layerName + "/{z}/{x}/{y}.pbf",
                serverType: "MVT",
                serverSubdomains: undefined,
                bbox: bbox,
                nameProp: nameProperty
            }
        };
        return fs.writeFilePromise(dataXmlFile, generateDataXml(layerName, bbox)); //, pgsql_db));
    }).then(function() {
        if (!steps.tileGeneration) return;
        // Generate mbtiles
        console.log('Running tile generation for ' + layerName);
        //return execPromise('echo node save_tiles.js ' + [dataXmlFile, mbtilesFile, const_minZ, const_maxGenZ].concat(returnData.regionMapping.bbox).join(' ') + ' > ' + mbtilesFile + '.txt');
        return execPromise('node save_tiles.js ' + [dataXmlFile, mbtilesFile, const_minZ, const_maxGenZ].concat(returnData.regionMapping.bbox).join(' '));
    }).then(function() {
        if (!steps.config) return;
        // Write out hybrid.json
        console.log('Tile generation finished for ' + layerName);
        return fs.writeFilePromise(hybridJsonFile, JSON.stringify({sources: [
            {source: "mbtiles://" + path.resolve(mbtilesFile), minZ: const_minZ, maxZ: const_maxGenZ},
            {source: "bridge://" + path.resolve(dataXmlFile), minZ: const_minZ, maxZ: const_maxZ}
        ]})).yield(returnData);
    }).catch(function(err) {
        console.log('Layer ' + layerName + ' failed with error: ' + err);
        throw err;
    });
}


// Read JSON file and extract layer names
var regionMappingJson = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
var regionMaps = Object.keys(regionMappingJson.regionWmsMap);

var layers = /*{};
for (var i = 0; i < regionMaps.length; i++) {
    layers[regionMappingJson.regionWmsMap[regionMaps[i]].layerName.replace('region_map:', '')] = false;
}*/ {FID_SA4_2011_AUST: false, FID_SA2_2011_AUST: false, FID_TM_WORLD_BORDERS: false};


// Only allow const_parallel_limit number of concurrent processLayer requests
var guardedProcessLayer = guard(guard.n(const_parallel_limit), processLayer);
var configJson = {};

var exitCode = 0;

when.map(Object.keys(layers).map(guardedProcessLayer), function(data) {
    // Add layer data to layers as each layer finishes processing
    if (data) {
        configJson['/' + data.layerName] = data.config;
        layers[data.layerName] = data.regionMapping;
    }
}).catch(function(err) {
    // Output the layers that aren't done if there is an error so that it is possible to only process these in another run
    // Replacing layers = {}; with layers = JSON.parse(fs.readFileSync('unfinished_layers.json'));
    // and commenting out the loop below that line will run the setup script for only the layers that were not finished in the last run
    console.log('Ending processing early due to errors');
    var unfinishedLayers = {};
    Object.keys(layers).forEach(function(layerName) { // Filter out finished layers
        if (!layers[layerName]) {
            unfinishedLayers[layerName] = false;
        }
    });
    exitCode = 1;
    return fs.writeFilePromise('unfinished_layers.json', JSON.stringify(unfinishedLayers, null, 4));
}).then(function() {
    // Once all layers have finished processing
    for (var i = 0; i < regionMaps.length; i++) {
        var layerName = regionMappingJson.regionWmsMap[regionMaps[i]].layerName.replace('region_map:', '');
        if (layers[layerName]) {
            Object.assign(regionMappingJson.regionWmsMap[regionMaps[i]], layers[layerName]); // Update properties
        }
        else {
            // Use WMS for this layer
            Object.assign(regionMappingJson.regionWmsMap[regionMaps[i]], {
                server: regionMappingJson.regionWmsMap[regionMaps[i]].server,
                serverType: "WMS"
            });
        }
    }

    return when.join(
        fs.writeFilePromise('config.json', JSON.stringify(configJson, null, 4)),
        fs.writeFilePromise('regionMapping_out.json', JSON.stringify(regionMappingJson, null, 2))
    );
}).then(function() { process.exit(exitCode); });
