'use strict';
module.exports = function () {
return [
{
	"title": "HOME",
	"route": "/",
	"controller": "app/main/*",
	"app": "main",
	"children": [
		{
			"title": "DEV_AREA",
			"route": "/dev",
			"app": "main",
			"controller": "app/main/main"
		}
	],
	"order": 1
},{
	"title": "ADMIN",
	"route": "/admin",
	"norouting": true,
	"controller": "app/admin/*",
	"app": "admin",
	"order": 4,
	"children": [
		{
			"title": "GROUPS",
			"route": "/admin/groups",
			"controller": "app/admin/groups/groups",
			"app": "admin"
		},
		{
			"title": "RIGHTS",
			"route": "/admin/rights",
			"controller": "app/admin/rights/*",
			"app": "admin"
		},
		{
			"title": "ROLES",
			"route": "/admin/roles",
			"controller": "app/admin/roles/roles",
			"app": "admin"
		},
		{
			"title": "USERS",
			"route": "/admin/users",
			"controller": "app/admin/users/users",
			"app": "admin"
		}
	]
}
];
};