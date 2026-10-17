// Reviewed application logic, evaluated only inside an isolated JavaScript heap.
function serve(input) {
 return {status:404,body:{error:'service_not_configured',serviceId:input.serviceId}};
}
