'use strict';

var val = require('lx-valid');
var lxHelpers = require('lx-helpers');

// filter property-type if it is an array or contains 'any'
function filterTypesOfPropertiesIfAnyOrArray (schema) {
    lxHelpers.forEach(schema, function (value, key) {
        if (value) {
            // delete all other property of an object, if type is typeof array or 'any'
            if (value.type && (value.type === 'any' || lxHelpers.isArray(value.type))) {
                var type = value.type;
                if (!(lxHelpers.isArray(type) && type.length === 2 && type.indexOf('null') !== -1)) {
                    schema[key] = {};
                    schema[key].type = type;
                }
                if (lxHelpers.isArray(type) && type.length > 2) {
                    schema[key] = {};
                    schema[key].type = 'any';
                }
            }
//            if (value.type && value.type === 'any') {
//                var type = value.type;
//                schema[key] = {};
//                schema[key].type = type;
//            }

            // recursion of object-value
            if (lxHelpers.isObject(value) && !lxHelpers.isArray(value)) {
                schema[key] = filterTypesOfPropertiesIfAnyOrArray(schema[key]);
            }
        }
    });
    return schema;
}

// merge properties of object to one property
function mergeTypesOfProperty (jsonValue, value) {
    var arrMergeProperty = [];

    // if value-type of schema is not of type any, then merge
    if (jsonValue !== 'any') {
        // set type to 'any' if object and single-value are types of property
        if (jsonValue === 'object' && value !== 'object' || value === 'object' && jsonValue !== 'object') {
            jsonValue = 'any';

            // set type to 'any' if array and single-value are types of property
        } else if (jsonValue === 'array' && value !== 'array' || value === 'array' && jsonValue !== 'array') {
            jsonValue = 'any';

        } else {
            arrMergeProperty = arrMergeProperty.concat(jsonValue, value);
            jsonValue = arrMergeProperty;
        }
    }

    return jsonValue;
}

// merge items of an array to one object
function mergeArrayItems (arrayItems, itemObject) {
    itemObject = itemObject || {};

    lxHelpers.forEach(arrayItems, function (value, key) {
        // recursion if arrayItem is array and item-value is not single-value
        if (val.types.array(arrayItems).valid && !val.types.string(value).valid) {
            itemObject = mergeArrayItems(value, itemObject);

            // if arrayItem is array and item-value is single-value, create property-array
        } else if (val.types.array(arrayItems).valid && val.types.string(value).valid) {
            itemObject = val.types.array(itemObject).valid ? itemObject : [];
            if (itemObject.indexOf(value) === -1) {
                itemObject.push(value);
            }
//            itemObject.push(value);

            // recursion if item-value is an array
        } else if (val.types.array(value).valid) {
            itemObject[key] = mergeArrayItems(value, itemObject[key]);

            // recursion if item-value is object
        } else if (val.types.object(value).valid && !val.types.array(value).valid) {
            itemObject[key] = mergeArrayItems(value, itemObject[key]);

        } else {
            if (itemObject[key]) {
                //check if schema-property has format-array to push
                if (val.types.array(itemObject[key]).valid) {
                    if (itemObject[key].indexOf(value) === -1) {
                        itemObject[key].push(value);
                    }
                    // check if schema-property has format as string to merge
                } else if (val.types.string(itemObject[key]).valid && value !== itemObject[key]) {
                    itemObject[key] = mergeTypesOfProperty(itemObject[key], value);
                    // else single-element-format is schema-property-format
                } else {
                    itemObject[key] = value;
                }
            }
            if (!itemObject[key]) {
                itemObject[key] = value;
            }
        }
    });

    return itemObject;
}

/**
 * Create schema for each document-metadata
 *
 * @param {object} metaData The metadata-documents from client
 * @param {object} schemaObject The schema-object
 * @returns {Object} The schema.
 **/
function createSchemaOfEachDocument (metaData, schemaObject) {
    lxHelpers.forEach(metaData, function (value, key) {
        // create schema-type of object if value is object
        if (val.types.object(value).valid && !val.types.array(value).valid) {
            schemaObject[key] = {
                type: 'object',
                properties: createSchemaOfEachDocument(value, {})
            };
        }
        // create schema-type of array if value is array
        if (val.types.array(value).valid) {
            schemaObject[key] = {
                type: 'array',
                items: createSchemaOfEachDocument(value, {})
            };

            if (Object.keys(schemaObject[key].items).length > 1) {
                var schemaTest = {};
                lxHelpers.forEach(schemaObject[key].items, function (value) {
                    schemaTest = mergeArrayItems(value, schemaTest);
                });
                schemaObject[key].items = schemaTest;
            } else if (Object.keys(schemaObject[key].items).length === 1) {
                schemaObject[key].items = schemaObject[key].items[0];
            }
        }

        if (val.types.string(value).valid) {
            schemaObject[key] = exports.getValidationObjectOfSingleElements(value, key);
        }
    });

    return schemaObject;
}

// Get validation-result of a single-element
exports.getValidationObjectOfSingleElements = function (data, key) {
    var properties = {};

    switch (data) {
        case 'float':
            properties = {
                type: 'number'
            };
            break;
        case 'date':
            properties = {
                type: 'string',
                format: 'date'
            };
            break;
        case 'ObjectID':
            properties = {
                type: 'string',
                format: 'mongo-id'
            };

            break;
        case 'date-time':
            properties = {
                type: 'string',
                format: 'date-time'
            };
            break;
        case 'regex':
            properties = {
                type: 'regexp'
            };
            break;
        case 'UUID':
            properties = {
                type: 'string',
                format: 'uuid'
            };
            break;
        case 'LUUID':
            properties = {
                type: 'string',
                format: 'luuid'
            };
            break;
        case 'Timestamp':
            properties = {
                type: 'string',
                format: 'timestamp'
            };
            break;
        case 'DBRef':
            properties = {
                type: 'dbRef'
            };
            break;
        case 'MinKey':
            properties = {
                type: 'minKey'
            };
            break;
        case 'MaxKey':
            properties = {
                type: 'maxKey'
            };
            break;
        case 'Code':
            properties = {
                type: 'code'
            };
            break;
        default:
            properties = {
                type: data
            };
            break;
    }

    // set special property to document-id
    if (key.toString() === '_id') {
        properties.key = true;
    }

    return properties;
};

// create schema from metadata
exports.getSchema = function (metadata) {
    var schema = {
        properties: {}
    };

    // loop through documents
//    lxHelpers.forEach(metadata, function (value, key) {
//        schema.properties = createSchemaOfEachDocument(metadata[key], schemaObject);
//    });
    var arrayOfDocumentsSchemata = [];
    // loop through documents
    lxHelpers.forEach(metadata, function (value, key) {
        arrayOfDocumentsSchemata.push(createSchemaOfEachDocument(metadata[key], {}));
    });
    schema.properties = mergeArrayItems(arrayOfDocumentsSchemata);

    return JSON.stringify(filterTypesOfPropertiesIfAnyOrArray(schema), null, '\t');
};
