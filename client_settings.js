'use strict';

module.exports.schema = {
    properties: {
        language: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    maxLength: 50
                },
                code: {
                    type: 'string',
                    minLength: 5,
                    maxLength: 5
                },
                flagURL: {
                    type: 'string',
                    maxLength: 200
                }
            }
        },
        default_view: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    maxLength: 20
                },
                cssClass: {
                    type: 'string',
                    maxLength: 200
                },
                pathToHTMLFile: {
                    type: 'string',
                    maxLength: 100
                }
            }
        },
        theme_find: {
            type: 'string',
            maxLength: 30
        },
        theme_console: {
            type: 'string',
            maxLength: 30
        },
        setIsEnabled: {
            type: 'boolean'
        },
        json_schema_validation: {
            type: 'boolean'
        },
        schema_delete_unknown_properties: {
            type: 'boolean'
        },
        default_page_size: {
            type: 'integer'
        },
        default_mongodb_port: {
            type: 'integer'
        }
    }
};

module.exports.settings = {};